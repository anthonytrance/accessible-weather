import test from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGES,
  STRINGS,
  beaufortForce,
  formatRainSummary,
  localizedCompass,
  localizedWeatherLabel,
  resolveLanguage,
  translate
} from "../i18n.js";

test("every language provides every key that English has", () => {
  const englishKeys = Object.keys(STRINGS.en).sort();
  for (const { code } of LANGUAGES) {
    const keys = Object.keys(STRINGS[code]).sort();
    assert.deepEqual(keys, englishKeys, `Key mismatch for language ${code}`);
  }
});

test("translations keep the same placeholders as English", () => {
  const placeholderSet = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const { code } of LANGUAGES) {
    for (const [key, english] of Object.entries(STRINGS.en)) {
      assert.deepEqual(
        placeholderSet(STRINGS[code][key]),
        placeholderSet(english),
        `Placeholder mismatch in ${code} for ${key}`
      );
    }
  }
});

test("language resolution honours preferences and falls back to English", () => {
  assert.equal(resolveLanguage("nl", "en-US"), "nl");
  assert.equal(resolveLanguage("auto", "fr-BE"), "fr");
  assert.equal(resolveLanguage("auto", "ja-JP"), "en");
  assert.equal(resolveLanguage("xx", "de-DE"), "de");
});

test("rain summaries localize into full sentences", () => {
  const formatTime = (epoch) => new Date(epoch).toISOString().slice(11, 16);
  const now = Date.parse("2026-07-17T16:00:00Z");
  const summary = {
    kind: "upcoming",
    minutesUntil: 15,
    firstTime: now + 900_000,
    endTime: now + 1_500_000,
    strongestTime: now + 1_200_000,
    firstMmPerHour: 0.5,
    strongestMmPerHour: 2
  };
  const english = formatRainSummary("en", summary, formatTime, "radar");
  assert.match(english.headline, /about 15 minutes/);
  assert.match(english.detail, /moderate rain/);
  const dutch = formatRainSummary("nl", summary, formatTime, "radar");
  assert.match(dutch.headline, /over ongeveer 15 minuten/);

  const dry = formatRainSummary("en", { kind: "dry", count: 24 }, formatTime, "model");
  assert.match(dry.headline, /No rain expected/);
  assert.match(dry.detail, /24 available 15-minute model intervals/);
});

test("weather labels, compass points and Beaufort forces localize", () => {
  assert.equal(localizedWeatherLabel("en", 63), "Rain");
  assert.equal(localizedWeatherLabel("nl", 63), "Regen");
  assert.equal(localizedWeatherLabel("de", 999), "Unbekannte Bedingungen");
  assert.equal(localizedCompass("fr", 90), "est");
  assert.equal(beaufortForce(0), 0);
  assert.equal(beaufortForce(19), 3);
  assert.equal(beaufortForce(20), 4);
  assert.equal(beaufortForce(120), 12);
  assert.equal(translate("es", "wind.force", { force: 4, name: translate("es", "beaufort.4") }), "fuerza 4, brisa moderada");
});
