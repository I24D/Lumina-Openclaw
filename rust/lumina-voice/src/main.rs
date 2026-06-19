//! Lumina voice sidecar — HTTP server on 127.0.0.1:4322.
//!
//! Routes:
//!   GET  /health                  — status + WinRT capability
//!   POST /voice/intent            — { "text": "..." } → executes intent
//!   POST /voice/speak             — { "text": "...", "lang"?: "es-MX" }
//!   POST /voice/listen/start      — begin continuous recognition
//!   POST /voice/listen/stop       — stop session
//!   GET  /voice/listen/events     — SSE stream of recognition events
//!                                  (auto-routes intents on `final`)
//!   GET  /voice/windows           — list visible windows (LLM context)
//!
//! The sidecar talks to the existing Lumina proxy on 4321 for "Ask" intents
//! (anything that isn't a deterministic Win32 action).

mod actions;
mod intent;
mod voice;

use anyhow::Result;
use crossbeam_channel::{unbounded, Receiver, Sender};
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server};

use crate::intent::{classify, strip_wake_word, Intent};
use crate::voice::{VoiceEvent, VoiceState};

const DEFAULT_PORT: u16 = 4322;
const PROXY_BASE: &str = "http://127.0.0.1:4321";
const DEFAULT_LANG: &str = "es-MX";

struct AppState {
    voice: Arc<VoiceState>,
    bus_tx: Sender<VoiceEvent>,
    /// Ring buffer of recent events for late SSE subscribers.
    recent: Mutex<VecDeque<VoiceEvent>>,
    subscribers: Mutex<Vec<Sender<VoiceEvent>>>,
    lang: String,
}

fn main() -> Result<()> {
    let port: u16 = std::env::var("LUMINA_VOICE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let lang = std::env::var("LUMINA_VOICE_LANG").unwrap_or_else(|_| DEFAULT_LANG.to_string());

    let voice = VoiceState::new();
    let (bus_tx, bus_rx) = unbounded::<VoiceEvent>();
    let state = Arc::new(AppState {
        voice,
        bus_tx: bus_tx.clone(),
        recent: Mutex::new(VecDeque::with_capacity(64)),
        subscribers: Mutex::new(Vec::new()),
        lang: lang.clone(),
    });

    // Bus fanout: keeps recent ring, dispatches to subscribers, auto-routes
    // intents on `Final` events.
    {
        let state = Arc::clone(&state);
        thread::spawn(move || bus_fanout(state, bus_rx));
    }

    let bind = format!("127.0.0.1:{port}");
    let server = Server::http(&bind)
        .map_err(|e| anyhow::anyhow!("bind {bind}: {e}"))?;
    eprintln!("[lumina-voice] listening on http://{bind}  (lang={lang})");

    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        thread::spawn(move || {
            if let Err(err) = handle(state, request) {
                eprintln!("[lumina-voice] handler error: {err:#}");
            }
        });
    }
    Ok(())
}

fn bus_fanout(state: Arc<AppState>, rx: Receiver<VoiceEvent>) {
    while let Ok(event) = rx.recv() {
        // Persist in ring buffer (last 64).
        {
            let mut ring = state.recent.lock().unwrap();
            if ring.len() == 64 {
                ring.pop_front();
            }
            ring.push_back(event.clone());
        }
        // Fan out to live SSE subscribers; drop dead ones.
        {
            let mut subs = state.subscribers.lock().unwrap();
            subs.retain(|tx| tx.send(event.clone()).is_ok());
        }
        // Auto-route any FINAL utterance that starts with the wake word.
        if let VoiceEvent::Final { text, .. } = &event {
            if let Some(rest) = strip_wake_word(text) {
                let intent_state = Arc::clone(&state);
                let phrase = rest.clone();
                thread::spawn(move || {
                    let outcome = execute_intent(&intent_state, &phrase, true);
                    if let Some(msg) = outcome.spoken {
                        // Best-effort confirmation TTS.
                        let _ = voice::speak(&msg, &intent_state.lang);
                    }
                });
            }
        }
    }
}

// ── HTTP routing ────────────────────────────────────────────────────────

fn handle(state: Arc<AppState>, mut request: Request) -> Result<()> {
    let method = request.method().clone();
    let url = request.url().to_string();
    let (path, _query) = match url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (url.clone(), String::new()),
    };

    match (method, path.as_str()) {
        (Method::Get, "/health") => respond_json(request, 200, serde_json::json!({
            "ok": true,
            "service": "lumina-voice",
            "lang": state.lang,
            "listening": state.voice.handle.lock().unwrap().is_some(),
        })),
        (Method::Post, "/voice/intent") => {
            let body = read_body(&mut request)?;
            #[derive(Deserialize)]
            struct In { text: String, #[serde(default)] strip_wake: bool }
            let input: In = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(e) => return respond_json(request, 400, serde_json::json!({
                    "ok": false, "error": "bad_json", "message": e.to_string(),
                })),
            };
            let phrase = if input.strip_wake {
                strip_wake_word(&input.text).unwrap_or(input.text)
            } else {
                input.text
            };
            let outcome = execute_intent(&state, &phrase, false);
            respond_json(request, if outcome.ok { 200 } else { 502 }, serde_json::to_value(&outcome)?)
        }
        (Method::Post, "/voice/speak") => {
            let body = read_body(&mut request)?;
            #[derive(Deserialize)]
            struct In { text: String, #[serde(default)] lang: Option<String> }
            let input: In = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(e) => return respond_json(request, 400, serde_json::json!({
                    "ok": false, "error": "bad_json", "message": e.to_string(),
                })),
            };
            let lang = input.lang.unwrap_or_else(|| state.lang.clone());
            match voice::speak(&input.text, &lang) {
                Ok(()) => respond_json(request, 200, serde_json::json!({"ok": true})),
                Err(e) => respond_json(request, 502, serde_json::json!({
                    "ok": false, "error": "tts_failed", "message": e.to_string(),
                })),
            }
        }
        (Method::Post, "/voice/listen/start") => {
            let mut guard = state.voice.handle.lock().unwrap();
            if guard.is_some() {
                return respond_json(request, 200, serde_json::json!({"ok": true, "already": true}));
            }
            match voice::start_continuous(&state.lang, state.bus_tx.clone()) {
                Ok(h) => {
                    *guard = Some(h);
                    respond_json(request, 200, serde_json::json!({"ok": true, "lang": state.lang}))
                }
                Err(e) => {
                    let msg = e.to_string();
                    let hint = if msg.contains("0x80045509") || msg.to_lowercase().contains("privacy policy") {
                        "Activa el reconocimiento de voz en línea: Configuración → Privacidad y seguridad → Voz."
                    } else if msg.contains("0x80045506") || msg.to_lowercase().contains("not installed") {
                        "Instala el paquete de voz del idioma: Configuración → Hora e idioma → Voz → Agregar."
                    } else if msg.contains("0x80004004") || msg.to_lowercase().contains("denied") {
                        "Concede permiso de micrófono a Lumina: Configuración → Privacidad y seguridad → Micrófono."
                    } else {
                        "Verifica idioma, micrófono y la configuración de voz en Windows."
                    };
                    respond_json(request, 502, serde_json::json!({
                        "ok": false, "error": "winrt_start_failed",
                        "lang": state.lang, "hint": hint, "message": msg,
                    }))
                }
            }
        }
        (Method::Post, "/voice/listen/stop") => {
            let mut guard = state.voice.handle.lock().unwrap();
            if let Some(h) = guard.take() {
                let _ = h.stop();
                let _ = state.bus_tx.send(VoiceEvent::Stopped);
            }
            respond_json(request, 200, serde_json::json!({"ok": true}))
        }
        (Method::Get, "/voice/listen/events") => stream_sse(state, request),
        (Method::Get, "/voice/windows") => {
            let wins = actions::list_visible_windows();
            respond_json(request, 200, serde_json::json!({"ok": true, "windows": wins}))
        }
        _ => respond_json(request, 404, serde_json::json!({
            "ok": false, "error": "not_found", "path": path,
        })),
    }
}

// ── Intent execution ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct Outcome {
    ok: bool,
    intent: Intent,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
    /// When set, the bus fanout speaks this. None on the HTTP path so the
    /// caller decides whether to play TTS.
    #[serde(skip)]
    spoken: Option<String>,
}

fn execute_intent(state: &AppState, phrase: &str, speak_confirmation: bool) -> Outcome {
    let intent = classify(phrase);
    let (ok, msg, details, spoken) = match &intent {
        Intent::OpenApp { app } => {
            let r = actions::open_app(app);
            let spoken = if speak_confirmation && r.ok {
                Some(format!("abriendo {app}"))
            } else {
                None
            };
            (r.ok, r.message, r.details, spoken)
        }
        Intent::CloseForegroundWindow => match actions::close_foreground_window() {
            Ok(r) => {
                let spoken = if speak_confirmation && r.ok {
                    Some("ventana cerrada".to_string())
                } else {
                    None
                };
                (r.ok, r.message, r.details, spoken)
            }
            Err(e) => (false, format!("error cerrando ventana: {e}"), None, None),
        },
        Intent::MinimizeForegroundWindow => {
            let r = actions::minimize_foreground_window();
            let spoken = if speak_confirmation && r.ok {
                Some("ventana minimizada".to_string())
            } else {
                None
            };
            (r.ok, r.message, r.details, spoken)
        }
        Intent::SetVolume { percent } => match actions::set_volume(*percent) {
            Ok(r) => {
                let spoken = if speak_confirmation && r.ok {
                    Some(format!("volumen al {percent}%"))
                } else {
                    None
                };
                (r.ok, r.message, r.details, spoken)
            }
            Err(e) => (false, format!("error volumen: {e}"), None, None),
        },
        Intent::SearchFile { query } => {
            let r = actions::search_file(query);
            let spoken = if speak_confirmation && r.ok {
                Some(r.message.clone())
            } else {
                None
            };
            (r.ok, r.message, r.details, spoken)
        }
        Intent::Speak { text } => {
            let _ = voice::speak(text, &state.lang);
            (true, format!("dije: {text}"), None, None)
        }
        Intent::Ask { text } => {
            // Delegate to Lumina proxy chat completion. Quick timeout — voice
            // UX shouldn't wait forever.
            match ask_lumina_brain(text) {
                Ok(answer) => {
                    let spoken = if speak_confirmation { Some(answer.clone()) } else { None };
                    (true, answer, None, spoken)
                }
                Err(e) => (false, format!("no pude consultar el cerebro: {e}"), None, None),
            }
        }
        Intent::Unknown { .. } => (false, "no entendí".to_string(), None, None),
    };

    Outcome { ok, intent, message: msg, details, spoken }
}

fn ask_lumina_brain(text: &str) -> Result<String> {
    let body = serde_json::json!({
        "model": "I24D",
        "messages": [
            {"role": "system", "content": "Eres Lumina, una asistente de voz local. Responde muy breve (1-2 frases) y claro."},
            {"role": "user", "content": text}
        ],
        "max_tokens": 200,
        "stream": false,
    });
    let resp = ureq::post(&format!("{PROXY_BASE}/v1/chat/completions"))
        .timeout(Duration::from_secs(20))
        .send_json(body)?
        .into_json::<serde_json::Value>()?;
    let content = resp
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        Err(anyhow::anyhow!("respuesta vacía del cerebro"))
    } else {
        Ok(content)
    }
}

// ── SSE stream ──────────────────────────────────────────────────────────

fn stream_sse(state: Arc<AppState>, request: Request) -> Result<()> {
    use std::io::Write;

    let (tx, rx) = unbounded::<VoiceEvent>();
    // Replay recent events.
    {
        let ring = state.recent.lock().unwrap();
        for ev in ring.iter() {
            let _ = tx.send(ev.clone());
        }
    }
    state.subscribers.lock().unwrap().push(tx);

    // Take ownership of the raw socket writer. tiny_http leaves headers to us.
    let mut writer = request.into_writer();

    // Minimal HTTP/1.1 SSE preamble — chunked transfer encoding so the
    // client doesn't expect a Content-Length.
    let preamble = "HTTP/1.1 200 OK\r\n\
        Content-Type: text/event-stream\r\n\
        Cache-Control: no-store\r\n\
        Connection: keep-alive\r\n\
        Transfer-Encoding: chunked\r\n\
        \r\n";
    if writer.write_all(preamble.as_bytes()).is_err() {
        return Ok(());
    }
    let _ = writer.flush();

    while let Ok(ev) = rx.recv() {
        let json = match serde_json::to_string(&ev) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let payload = format!("data: {json}\n\n");
        // Chunked encoding: <hex-len>\r\n<data>\r\n
        let chunk_header = format!("{:x}\r\n", payload.len());
        if writer.write_all(chunk_header.as_bytes()).is_err()
            || writer.write_all(payload.as_bytes()).is_err()
            || writer.write_all(b"\r\n").is_err()
        {
            break;
        }
        if writer.flush().is_err() {
            break;
        }
    }
    // Terminator chunk.
    let _ = writer.write_all(b"0\r\n\r\n");
    let _ = writer.flush();
    Ok(())
}

// ── HTTP helpers ────────────────────────────────────────────────────────

fn respond_json(request: Request, status: u16, body: serde_json::Value) -> Result<()> {
    let json = serde_json::to_string(&body)?;
    let response = Response::from_string(json)
        .with_status_code(status)
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    request.respond(response)?;
    Ok(())
}

fn read_body(request: &mut Request) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut buf = Vec::new();
    request.as_reader().read_to_end(&mut buf)?;
    Ok(buf)
}
