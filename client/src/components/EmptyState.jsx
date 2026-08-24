import { IconFolder } from './icons.jsx';

export default function EmptyState({ title = 'No holdings yet', text }) {
  return (
    <div className="empty-wrap">
      <IconFolder className="empty-illus" />
      <div className="empty-title">{title}</div>
      <div className="empty-text">{text || 'Add a version with target weights to start tracking this model.'}</div>
      <button className="btn-primary">Add holdings</button>
    </div>
  );
}
