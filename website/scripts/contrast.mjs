import assert from 'node:assert/strict';

export function rgba(value) {
  if (value.startsWith('#')) {
    const rgb = value.slice(1).match(/../g).map((part) => parseInt(part, 16));
    return [...rgb, 1];
  }
  const parts = value.match(/[\d.]+/g)?.map(Number);
  assert(parts?.length >= 3, `Unsupported rendered color: ${value}`);
  return [...parts.slice(0, 3), parts[3] ?? 1];
}
export function composite(front, back) {
  const alpha = front[3] + back[3] * (1 - front[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [...front.slice(0, 3).map((channel, index) =>
    (channel * front[3] + back[index] * back[3] * (1 - front[3])) / alpha), alpha];
}
export function contrast(first, second) {
  const luminance = (color) => color.slice(0, 3).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
export function requireContrast(foreground, background, minimum, label) {
  const bg = rgba(background);
  const ratio = contrast(composite(rgba(foreground), bg), bg);
  assert(ratio >= minimum, `${label}: ${ratio.toFixed(2)} < ${minimum}`);
  return ratio;
}
