export function fmt(v, _unit, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return Number(v).toFixed(digits);
}

export function gaugePct(value, max) {
  if (!max) return 0;
  return Math.max(0, Math.min(1, value / max));
}

const STAGE = {
  0: 'Standby', 1: 'Activated', 2: 'MPPT Tracking', 3: 'Equalizing',
  4: 'Boost Charging', 5: 'Float Charging', 6: 'Current Limiting',
  8: 'Alternator Direct',
};
export function stageLabel(code) {
  return STAGE[code] || 'Standby';
}
