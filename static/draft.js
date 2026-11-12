'use strict';
// Drafts stay on this browser; no message text is sent by this helper.
class TextdropDraft {
  constructor(storage, now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
    this.key = 'textdrop-draft-v1';
    this.lifetime = 7 * 24 * 60 * 60 * 1000;
  }
  load() {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    let draft;
    try { draft = JSON.parse(raw); } catch { draft = null; }
    const pending = draft?.pending;
    if (!draft || typeof draft.text !== 'string' || draft.text.length > 100000 ||
        !Number.isFinite(draft.updated) || draft.updated > this.now() || this.now() - draft.updated >= this.lifetime ||
        (pending && (typeof pending.text !== 'string' || pending.text.length > 100000 || typeof pending.id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(pending.id)))) {
      this.clear();
      return null;
    }
    return draft;
  }
  save(text, pending) {
    if (!text && !pending) return this.clear();
    this.storage.setItem(this.key, JSON.stringify({text, pending, updated: this.now()}));
  }
  clear() { this.storage.removeItem(this.key); }
}
window.TextdropDraft = TextdropDraft;
