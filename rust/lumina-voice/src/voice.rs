//! WinRT speech recognition + synthesis.
//!
//! Recognition runs in continuous-dictation mode on a worker thread; results
//! are dispatched as `VoiceEvent::Final` / `Hypothesis` via a crossbeam
//! channel that the HTTP server reads from for the SSE stream.
//!
//! Synthesis is a one-shot blocking call — we render to PCM, write to a temp
//! WAV, and play it back via the default Media Player (the simplest path that
//! works headless).

use anyhow::{anyhow, Context, Result};
use crossbeam_channel::Sender;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use windows::core::{Interface, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionMode, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechRecognitionConfidence, SpeechRecognitionHypothesisGeneratedEventArgs,
    SpeechRecognitionTopicConstraint, SpeechRecognitionScenario, SpeechRecognizer,
};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceEvent {
    Started { language: String },
    Stopped,
    Hypothesis { text: String, at: String },
    Final { text: String, confidence: String, at: String },
    Error { message: String, at: String },
}

fn now_iso() -> String {
    use std::time::UNIX_EPOCH;
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let ms = dur.subsec_millis();
    format!("{}.{:03}Z", secs, ms)
}

fn confidence_label(c: SpeechRecognitionConfidence) -> &'static str {
    match c {
        SpeechRecognitionConfidence::High => "high",
        SpeechRecognitionConfidence::Medium => "medium",
        SpeechRecognitionConfidence::Low => "low",
        SpeechRecognitionConfidence::Rejected => "rejected",
        _ => "unknown",
    }
}

/// Holds the active recognizer so the HTTP server can stop it on `/voice/stop`.
pub struct RecognizerHandle {
    recognizer: SpeechRecognizer,
}

impl RecognizerHandle {
    pub fn stop(&self) -> Result<()> {
        let async_op = self.recognizer.ContinuousRecognitionSession()?.StopAsync()?;
        async_op.get().context("StopAsync.get()")?;
        Ok(())
    }
}

/// Start continuous speech recognition. Returns a handle that the caller must
/// keep alive (dropping it will stop the session).
pub fn start_continuous(
    language_tag: &str,
    bus: Sender<VoiceEvent>,
) -> Result<RecognizerHandle> {
    let lang = Language::CreateLanguage(&HSTRING::from(language_tag))
        .with_context(|| format!("CreateLanguage({language_tag})"))?;
    let recognizer = SpeechRecognizer::Create(&lang)
        .with_context(|| format!("SpeechRecognizer::Create({language_tag})"))?;

    // Dictation topic constraint — broadest grammar. We do intent classification
    // afterwards in Rust over the resulting text.
    let topic = SpeechRecognitionTopicConstraint::Create(
        SpeechRecognitionScenario::Dictation,
        &HSTRING::from("LuminaDictation"),
    )
    .context("SpeechRecognitionTopicConstraint::Create(Dictation)")?;
    recognizer.Constraints()?.Append(&topic)?;

    let compile = recognizer.CompileConstraintsAsync()?.get()?;
    if compile.Status()? != windows::Media::SpeechRecognition::SpeechRecognitionResultStatus::Success {
        return Err(anyhow!(
            "CompileConstraints failed: status={:?}",
            compile.Status()?
        ));
    }

    // Hypothesis stream → fast partial text for UI feedback.
    let bus_for_hyp = bus.clone();
    let hyp_token = recognizer.HypothesisGenerated(&TypedEventHandler::<
        SpeechRecognizer,
        SpeechRecognitionHypothesisGeneratedEventArgs,
    >::new(move |_sender, args| {
        if let Some(args) = args.as_ref() {
            if let Ok(hyp) = args.Hypothesis() {
                if let Ok(text) = hyp.Text() {
                    let _ = bus_for_hyp.send(VoiceEvent::Hypothesis {
                        text: text.to_string_lossy(),
                        at: now_iso(),
                    });
                }
            }
        }
        Ok(())
    }))?;
    let _ = hyp_token; // event registration kept alive by the recognizer

    // Continuous-session ResultGenerated → final transcribed phrase.
    let session = recognizer.ContinuousRecognitionSession()?;
    let bus_for_final = bus.clone();
    let _result_token = session.ResultGenerated(&TypedEventHandler::<
        _,
        SpeechContinuousRecognitionResultGeneratedEventArgs,
    >::new(move |_sender, args| {
        if let Some(args) = args.as_ref() {
            if let Ok(result) = args.Result() {
                let text = result
                    .Text()
                    .map(|h| h.to_string_lossy())
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    let conf = result.Confidence().unwrap_or(SpeechRecognitionConfidence::Low);
                    let _ = bus_for_final.send(VoiceEvent::Final {
                        text,
                        confidence: confidence_label(conf).to_string(),
                        at: now_iso(),
                    });
                }
            }
        }
        Ok(())
    }))?;

    session
        .StartWithModeAsync(SpeechContinuousRecognitionMode::Default)?
        .get()
        .context("StartWithModeAsync.get()")?;

    let _ = bus.send(VoiceEvent::Started {
        language: language_tag.to_string(),
    });

    Ok(RecognizerHandle { recognizer })
}

/// Synchronously synthesize `text` to the default audio endpoint. Blocks until
/// playback completes. Slower than streaming but reliable for short
/// confirmations ("abriendo Chrome", "volumen al 50%").
pub fn speak(text: &str, language_tag: &str) -> Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let synth = SpeechSynthesizer::new().context("SpeechSynthesizer::new")?;
    if let Ok(voices) = SpeechSynthesizer::AllVoices() {
        let count = voices.Size().unwrap_or(0);
        for i in 0..count {
            let voice = voices.GetAt(i)?;
            let lang = voice.Language().unwrap_or_default().to_string_lossy();
            if lang.starts_with(language_tag.split('-').next().unwrap_or(language_tag)) {
                synth.SetVoice(&voice)?;
                break;
            }
        }
    }

    let stream = synth
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))?
        .get()
        .context("SynthesizeTextToStreamAsync.get()")?;

    // SpeechSynthesisStream implements IRandomAccessStream — cast then read.
    let random_access: windows::Storage::Streams::IRandomAccessStream = stream.cast()?;
    let bytes = read_random_access_stream(&random_access)?;
    let mut wav_path = std::env::temp_dir();
    wav_path.push(format!("lumina-voice-{}.wav", std::process::id()));
    std::fs::write(&wav_path, &bytes).context("write wav")?;

    let script = format!(
        "$p = New-Object System.Media.SoundPlayer '{}'; $p.PlaySync()",
        wav_path.display().to_string().replace('\'', "''")
    );
    let _ = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status();

    let _ = std::fs::remove_file(&wav_path);
    Ok(())
}

fn read_random_access_stream(
    stream: &windows::Storage::Streams::IRandomAccessStream,
) -> Result<Vec<u8>> {
    use windows::Storage::Streams::DataReader;
    let input = stream.GetInputStreamAt(0)?;
    let reader = DataReader::CreateDataReader(&input)?;
    let total = stream.Size()? as u32;
    if total == 0 {
        return Ok(Vec::new());
    }
    let loaded = reader.LoadAsync(total)?.get()?;
    let mut out = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut out)?;
    Ok(out)
}

/// Globally guarded recognizer registry: only one continuous session at a
/// time. The HTTP handlers grab this lazily.
pub struct VoiceState {
    pub handle: Mutex<Option<RecognizerHandle>>,
}

impl VoiceState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            handle: Mutex::new(None),
        })
    }
}
