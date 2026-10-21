import { User, Users, Megaphone, CircleDashed } from 'lucide-react';
import type { ChatKind } from '../../services/api';

function KindIcon({ kind, size = 20 }: { kind: ChatKind; size?: number }) {
  if (kind === 'group' || kind === 'broadcast') return <Users size={size} />;
  if (kind === 'channel') return <Megaphone size={size} />;
  if (kind === 'status') return <CircleDashed size={size} />;
  return <User size={size} />;
}

export default KindIcon;
