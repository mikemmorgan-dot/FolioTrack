import { typeColor } from '../api.js';

export default function AssetIcon({ symbol, type }) {
  const root = (symbol || '?').replace(/\..*$/, '').slice(0, 4);
  const label = root.length > 3 ? root.slice(0, 3) : root;
  return (
    <span className="asset-icon" style={{ '--ai-c': typeColor(type) }} aria-hidden>
      {label}
    </span>
  );
}
