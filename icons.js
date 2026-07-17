// Decorative inline SVG weather icons. Every icon is stroke-based, inherits
// currentColor, and is always injected with aria-hidden so screen readers rely
// on the spoken sentence next to it instead.

const SUN_CORE = '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4.6"/><line x1="12" y1="19.4" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="6.8" y2="6.8"/><line x1="17.2" y1="17.2" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="4.6" y2="12"/><line x1="19.4" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="6.8" y2="17.2"/><line x1="17.2" y1="6.8" x2="19.1" y2="4.9"/>';

const CLOUD = '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>';
const CLOUD_HIGH = '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/>';

const ICONS = {
  "clear-day": SUN_CORE,
  "clear-night": '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  "partly-day": '<circle cx="7.5" cy="7.5" r="3"/><line x1="7.5" y1="1.5" x2="7.5" y2="3"/><line x1="1.5" y1="7.5" x2="3" y2="7.5"/><line x1="3.2" y1="3.2" x2="4.3" y2="4.3"/><path d="M17.5 21h-8a4.5 4.5 0 1 1 .84-8.92A5.5 5.5 0 0 1 21 14.5 4.5 4.5 0 0 1 17.5 21z"/>',
  "partly-night": '<path d="M11 5.1A5.4 5.4 0 1 0 15.9 10 4.2 4.2 0 0 1 11 5.1z"/><path d="M17.5 21h-8a4.5 4.5 0 1 1 .84-8.92A5.5 5.5 0 0 1 21 14.5 4.5 4.5 0 0 1 17.5 21z"/>',
  cloud: CLOUD,
  overcast: '<path d="M18 14h-1.26A8 8 0 1 0 9 24h9a5 5 0 0 0 0-10z" transform="translate(0,-4)"/><path d="M6.5 5.5h9" opacity="0.7"/><path d="M4.5 8.5h13" opacity="0.7"/>',
  fog: CLOUD_HIGH + '<line x1="5" y1="19" x2="19" y2="19"/><line x1="7" y1="22" x2="17" y2="22"/>',
  drizzle: CLOUD_HIGH + '<line x1="8" y1="19" x2="8" y2="20"/><line x1="12" y1="21" x2="12" y2="22"/><line x1="16" y1="19" x2="16" y2="20"/>',
  rain: CLOUD_HIGH + '<line x1="8" y1="18" x2="7" y2="22"/><line x1="12" y1="18" x2="11" y2="22"/><line x1="16" y1="18" x2="15" y2="22"/>',
  "heavy-rain": CLOUD_HIGH + '<line x1="7" y1="17.5" x2="5.6" y2="22.5"/><line x1="10.4" y1="17.5" x2="9" y2="22.5"/><line x1="13.8" y1="17.5" x2="12.4" y2="22.5"/><line x1="17.2" y1="17.5" x2="15.8" y2="22.5"/>',
  sleet: CLOUD_HIGH + '<line x1="8" y1="18" x2="7.3" y2="21"/><circle cx="12" cy="20.5" r="0.6"/><line x1="16" y1="18" x2="15.3" y2="21"/>',
  snow: CLOUD_HIGH + '<circle cx="8" cy="19.5" r="0.7"/><circle cx="12" cy="21.5" r="0.7"/><circle cx="16" cy="19.5" r="0.7"/>',
  thunder: CLOUD_HIGH + '<polyline points="12.5 12.5 9.5 18 14.5 18 11.5 23.5"/>'
};

export function iconNameFor(code, isDay = true) {
  const numeric = Number(code);
  if (numeric === 0 || numeric === 1) return isDay ? "clear-day" : "clear-night";
  if (numeric === 2) return isDay ? "partly-day" : "partly-night";
  if (numeric === 3) return "cloud";
  if (numeric === 45 || numeric === 48) return "fog";
  if (numeric >= 51 && numeric <= 57) return "drizzle";
  if (numeric === 61 || numeric === 80) return "rain";
  if (numeric === 63 || numeric === 81) return "rain";
  if (numeric === 65 || numeric === 82) return "heavy-rain";
  if (numeric === 66 || numeric === 67) return "sleet";
  if ((numeric >= 71 && numeric <= 77) || numeric === 85 || numeric === 86) return "snow";
  if (numeric >= 95) return "thunder";
  return "cloud";
}

export function svgIcon(name, className = "wx-icon") {
  const body = ICONS[name] ?? ICONS.cloud;
  return `<svg class="${className}" data-icon="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function iconElement(document, code, isDay, className) {
  const span = document.createElement("span");
  span.className = "wx-icon-holder";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = svgIcon(iconNameFor(code, isDay), className ?? "wx-icon");
  return span;
}
