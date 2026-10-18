import type { ChatKind } from '../../services/api';
import KindIcon from './KindIcon';

// Chat list avatar. Renders from the sidebar's ONE batch request (useProfilePictures) — firing a
// query per row burst the per-IP throttle into 429s. The generic icon stays while the batch loads
// or when the contact hides their picture. The group info dialog shows it large, with `onImageError`
// refetching an expired CDN URL.
function ChatAvatar({
  pictureUrl,
  kind,
  size,
  onImageError,
}: {
  pictureUrl?: string | null;
  kind: ChatKind;
  size?: 'lg';
  onImageError?: () => void;
}) {
  const className = size ? `chat-avatar avatar-${size}` : 'chat-avatar';
  if (pictureUrl) {
    return (
      <div className={className}>
        <img src={pictureUrl} alt="" onError={onImageError} />
      </div>
    );
  }
  return (
    <div className={className}>
      <KindIcon kind={kind} size={size === 'lg' ? 40 : 20} />
    </div>
  );
}

export default ChatAvatar;
