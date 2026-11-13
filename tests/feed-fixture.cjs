// Shared fake transport for visual fixtures; production behavior is covered by real HTTP tests.
module.exports = (getNotes, getTrash = () => []) => {
  let revision = 0, previous = new Map();
  const changes = new Map();
  return request => {
    if (request.method() !== 'GET') return null;
    const url = new URL(request.url());
    const match = url.pathname.match(/^\/api\/(notes|trash)\/(page|changes)$/);
    if (!match) {
      if (/^\/api\/notes\/[^/]+$/.test(url.pathname)) {
        const note = getNotes().find(note => note.id === url.pathname.split('/').pop());
        return note ? {json: note} : {status: 404, json: {error: 'Удалено'}};
      }
      return null;
    }
    const active = getNotes(), trash = getTrash();
    const current = new Map([...active.map(note => ['notes/' + note.id, JSON.stringify(note)]), ...trash.map(note => ['trash/' + note.id, JSON.stringify(note)])]);
    for (const id of new Set([...previous.keys(), ...current.keys()])) {
      if (previous.get(id) !== current.get(id)) changes.set(id.slice(id.indexOf('/') + 1), ++revision);
    }
    previous = current;
    const isTrash = match[1] === 'trash', key = isTrash ? 'deleted' : 'created';
    const source = isTrash ? trash : active;
    const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
    const matches = note => note.text.toLocaleLowerCase().includes(query);
    const filtered = source.filter(matches).sort((a, b) => b[key] - a[key] || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
    const counters = {total: source.length, matched: filtered.length, revision};
    if (match[2] === 'page') {
      const before = url.searchParams.get('before');
      const [time, id] = before ? JSON.parse(Buffer.from(before, 'base64url')) : [Infinity, ''];
      const remaining = filtered.filter(note => note[key] < time || note[key] === time && note.id < id);
      const items = remaining.slice(0, Number(url.searchParams.get('limit') || 50));
      const last = items.at(-1);
      const next = items.length < remaining.length ? Buffer.from(JSON.stringify([last[key], last.id])).toString('base64url') : null;
      return {json: {...counters, items, next}};
    }
    const since = Number(url.searchParams.get('since'));
    const items = [], removed = [];
    for (const [id, change] of changes) if (change > since) {
      const note = source.find(note => note.id === id);
      if (note) items.push({...note, matches: matches(note)});
      else removed.push(id);
    }
    return {json: {...counters, items, removed, has_more: false}};
  };
};
