//! Effect → ffmpeg mapping.
//!
//! This is the authoritative translation from the editor's filter stack to a
//! filtergraph. `src/lib/effectChain.ts` carries a twin used by the browser
//! build; the inspector reports which one produced the chain it is showing, so
//! a drift between the two is visible rather than silent.

use serde::Serialize;

use crate::model::Effect;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectChain {
    /// One fragment per enabled, non-neutral effect, in stack order.
    pub filters: Vec<String>,
    /// Those fragments joined into a filtergraph chain.
    pub chain: String,
    pub engine: String,
}

/// Neutral values are skipped: a filter that changes nothing costs a pass.
pub fn effect_filters(effects: &[Effect]) -> Vec<String> {
    let mut filters = Vec::new();

    for effect in effects {
        if !effect.enabled {
            continue;
        }

        match effect.kind.as_str() {
            "brightness" => {
                let amount = effect.param("amount", 0.0);
                if amount != 0.0 {
                    filters.push(format!("eq=brightness={amount:.3}"));
                }
            }
            "contrast" => {
                let amount = effect.param("amount", 1.0);
                if amount != 1.0 {
                    filters.push(format!("eq=contrast={amount:.3}"));
                }
            }
            "saturation" => {
                let amount = effect.param("amount", 1.0);
                if amount != 1.0 {
                    filters.push(format!("eq=saturation={amount:.3}"));
                }
            }
            "blur" => {
                // CSS blur() takes a radius; ffmpeg's gblur takes a standard
                // deviation, which is roughly half of it.
                let radius = effect.param("radius", 0.0);
                if radius > 0.0 {
                    filters.push(format!("gblur=sigma={:.2}", radius / 2.0));
                }
            }
            "hue" => {
                let angle = effect.param("angle", 0.0);
                if angle != 0.0 {
                    filters.push(format!("hue=h={}", angle.round() as i64));
                }
            }
            "grayscale" => {
                let amount = effect.param("amount", 0.0);
                if amount > 0.0 {
                    filters.push(format!("hue=s={:.3}", 1.0 - amount));
                }
            }
            unknown => {
                // Forward-compatible: a document written by a newer UI keeps
                // its effect, and the encoder simply ignores what it cannot map.
                eprintln!("veglass: effet inconnu ignoré au rendu : {unknown}");
            }
        }
    }

    filters
}

pub fn describe(effects: &[Effect]) -> EffectChain {
    let filters = effect_filters(effects);
    EffectChain {
        chain: filters.join(","),
        filters,
        engine: "rust".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn effect(kind: &str, key: &str, value: f64) -> Effect {
        let mut params = HashMap::new();
        params.insert(key.to_string(), value);
        Effect { id: "fx".into(), kind: kind.into(), enabled: true, params }
    }

    /// These strings are the contract with `src/lib/effectChain.ts`; the twin
    /// must produce them character for character.
    #[test]
    fn maps_each_effect_kind() {
        assert_eq!(effect_filters(&[effect("brightness", "amount", 0.15)]), ["eq=brightness=0.150"]);
        assert_eq!(effect_filters(&[effect("contrast", "amount", 1.2)]), ["eq=contrast=1.200"]);
        assert_eq!(effect_filters(&[effect("saturation", "amount", 1.35)]), ["eq=saturation=1.350"]);
        assert_eq!(effect_filters(&[effect("blur", "radius", 6.0)]), ["gblur=sigma=3.00"]);
        assert_eq!(effect_filters(&[effect("hue", "angle", 30.0)]), ["hue=h=30"]);
        assert_eq!(effect_filters(&[effect("grayscale", "amount", 1.0)]), ["hue=s=0.000"]);
    }

    #[test]
    fn skips_neutral_and_disabled_effects() {
        assert!(effect_filters(&[effect("brightness", "amount", 0.0)]).is_empty());
        assert!(effect_filters(&[effect("contrast", "amount", 1.0)]).is_empty());

        let mut off = effect("blur", "radius", 8.0);
        off.enabled = false;
        assert!(effect_filters(&[off]).is_empty());
    }

    #[test]
    fn preserves_stack_order_in_the_chain() {
        let chain = describe(&[
            effect("blur", "radius", 4.0),
            effect("saturation", "amount", 2.0),
        ]);
        assert_eq!(chain.chain, "gblur=sigma=2.00,eq=saturation=2.000");
        assert_eq!(chain.engine, "rust");
    }

    #[test]
    fn unknown_kinds_are_ignored_not_fatal() {
        assert!(effect_filters(&[effect("bokeh-from-a-newer-build", "amount", 1.0)]).is_empty());
    }
}
