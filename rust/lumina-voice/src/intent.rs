//! Intent classifier — fast regex pass over recognized text.
//!
//! Resolution order: more specific intents first so `volumen al 50 por ciento`
//! doesn't accidentally match the generic "abre <algo>" rule.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Intent {
    OpenApp { app: String },
    CloseForegroundWindow,
    MinimizeForegroundWindow,
    SetVolume { percent: u32 },
    SearchFile { query: String },
    Speak { text: String },
    Ask { text: String },
    Unknown { text: String },
}

type Builder = fn(&regex::Captures) -> Intent;

static RULES: Lazy<Vec<(Regex, Builder)>> = Lazy::new(|| {
    vec![
        (
            Regex::new(
                r"(?i)\b(?:cambia\s+|sube\s+|baja\s+|pon|set)?\s*(?:el\s+)?volumen\s+(?:a(?:l)?\s+|to\s+)?(?P<p>\d{1,3})\s*(?:%|por\s*ciento|percent)?",
            ).unwrap(),
            |c| Intent::SetVolume {
                percent: c["p"].parse::<u32>().unwrap_or(50).min(100),
            },
        ),
        (
            Regex::new(r"(?i)\b(?:cierra|close)\s+(?:esta|this|la|the)?\s*ventana|\bclose\s+window\b")
                .unwrap(),
            |_| Intent::CloseForegroundWindow,
        ),
        (
            Regex::new(r"(?i)\b(?:minimiza|minimize)\s+(?:esta|this|la|the)?\s*ventana").unwrap(),
            |_| Intent::MinimizeForegroundWindow,
        ),
        (
            Regex::new(
                r"(?i)\b(?:busca|encuentra|find|search)\s+(?:el\s+|la\s+|the\s+)?(?:archivo|file)\s+(?P<q>.+?)\s*$",
            ).unwrap(),
            |c| Intent::SearchFile {
                query: c["q"].trim().to_string(),
            },
        ),
        (
            Regex::new(r"(?i)\b(?:abre|abrir|launch|open|arranca|inicia)\s+(?P<app>.+?)\s*$")
                .unwrap(),
            |c| Intent::OpenApp {
                app: c["app"].trim().to_string(),
            },
        ),
        (
            Regex::new(r"(?i)\b(?:di|say|speak|pronuncia)\s+(?P<t>.+?)\s*$").unwrap(),
            |c| Intent::Speak {
                text: c["t"].trim().to_string(),
            },
        ),
    ]
});

/// Strip a leading wake word ("Lumina", "luminia", "luminá", etc.) plus
/// optional vocative punctuation so downstream rules see the bare command.
pub fn strip_wake_word(input: &str) -> Option<String> {
    static WAKE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)^\s*lumin(?:a|ia|á)\s*[,:.]?\s*(?P<rest>.+)$").unwrap());
    WAKE.captures(input).map(|c| c["rest"].trim().to_string())
}

pub fn classify(text: &str) -> Intent {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Intent::Unknown {
            text: String::new(),
        };
    }

    for (re, build) in RULES.iter() {
        if let Some(caps) = re.captures(trimmed) {
            return build(&caps);
        }
    }

    Intent::Ask {
        text: trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_word_stripped() {
        assert_eq!(strip_wake_word("Lumina abre Chrome").as_deref(), Some("abre Chrome"));
        assert_eq!(strip_wake_word("lumina, cierra ventana").as_deref(), Some("cierra ventana"));
        assert_eq!(strip_wake_word("hola lumina"), None);
    }

    #[test]
    fn intents() {
        assert!(matches!(classify("abre vscode"), Intent::OpenApp { .. }));
        assert!(matches!(classify("volumen al 50 por ciento"), Intent::SetVolume { percent: 50 }));
        assert!(matches!(classify("cierra esta ventana"), Intent::CloseForegroundWindow));
        assert!(matches!(classify("busca el archivo reporte.xlsx"), Intent::SearchFile { .. }));
        assert!(matches!(classify("dime un chiste"), Intent::Ask { .. }));
    }
}
