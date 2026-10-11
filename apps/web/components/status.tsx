import { Badge } from './ui/misc';

export function PropertyStatusBadge({ status }: { status: 'draft' | 'published' | 'unpublished' }) {
  if (status === 'published') return <Badge variant="success">Published</Badge>;
  if (status === 'unpublished') return <Badge variant="warning">Unpublished</Badge>;
  return <Badge variant="secondary">Draft</Badge>;
}
