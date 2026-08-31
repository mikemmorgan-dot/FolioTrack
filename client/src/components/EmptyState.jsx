import { IconFolder } from './icons.jsx';

export default function EmptyState({ title = 'No holdings yet', text, onAction }) {
  return (
    <div className="empty-wrap">
      <IconFolder className="empty-illus" />
      <div className="empty-title">{title}</div>
      <div className="empty-text">{text || 'Add a version with target weights to start tracking this model.'}</div>
      {onAction && <button className="btn-primary" onClick={onAction}>Add holdings</button>}
    </div>
  );
}
