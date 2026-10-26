export async function getGvuiLaunchUrl(layoutId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/ampp-proxy/gvui/${encodeURIComponent(layoutId)}/launch`, {
    credentials: 'include', cache: 'no-store', signal,
  });
  const body = await response.json() as { url?: unknown; message?: string | string[] };
  if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(', ') : body.message || 'Unable to open this GV.UI layout.');
  const expected = `/api/ampp-proxy/ui/gvui-${layoutId.toLowerCase()}/gvui/desktop/${layoutId.toLowerCase()}`;
  if (body.url !== expected) throw new Error('The server returned an invalid GV.UI launch address.');
  return expected;
}
