'use strict';
// One inline editor instance survives history refreshes; user text never becomes HTML.
class TextdropEditor {
  constructor(note, {api, onSaved, onCancel, onConflict, onGone}) {
    Object.assign(this, {note, api, onSaved, onCancel, onConflict, onGone});
    this.id = note.id;
    this.remote = null;
    this.saving = false;
    this.deleted = false;
    this.closed = false;
    this.error = '';
    this.element = document.createElement('form');
    this.element.className = 'edit-form';
    this.element.setAttribute('aria-label', 'Редактирование сообщения');
    this.element.innerHTML = `<label for="message-edit-text">Твой вариант</label>
      <textarea id="message-edit-text" aria-label="Текст сообщения" data-action="edit-text" rows="4" maxlength="100000" required></textarea>
      <p class="edit-feedback" role="status" hidden></p>
      <div class="edit-conflict" hidden><h3>Версия на другом устройстве</h3><pre class="edit-remote-text"></pre><button type="button" class="edit-accept quiet">Принять эту версию</button></div>
      <div class="edit-actions"><button type="submit" class="edit-save">Сохранить</button><button type="button" class="edit-cancel quiet">Отмена</button></div>
      <p class="edit-hint">Ctrl / ⌘ + Enter — сохранить · Esc — отменить</p>`;
    this.field = this.element.querySelector('textarea');
    this.field.value = note.text;
    this.saveButton = this.element.querySelector('.edit-save');
    this.cancelButton = this.element.querySelector('.edit-cancel');
    this.acceptButton = this.element.querySelector('.edit-accept');
    this.feedback = this.element.querySelector('.edit-feedback');
    this.field.oninput = () => { this.error = ''; this.update(); };
    this.cancelButton.onclick = () => {
      if (this.saving) return;
      this.closed = true;
      this.onCancel(this);
    };
    this.acceptButton.onclick = () => {
      if (!this.remote || this.saving) return;
      this.closed = true;
      this.onSaved(this.remote, this);
    };
    this.field.onkeydown = event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.cancelButton.click(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.element.requestSubmit(); }
    };
    this.element.onsubmit = event => { event.preventDefault(); this.save(); };
    this.update();
  }
  reconcile(notes) {
    if (this.closed || this.saving) return;
    if (this.errorKind === 'auth') { this.error = ''; this.errorKind = ''; }
    const current = notes.find(note => note.id === this.id);
    if (!current) { this.deleted = true; this.update(); return; }
    if (this.deleted) { this.deleted = false; this.error = ''; this.errorKind = ''; }
    if ((current.version ?? 0) > (this.note.version ?? 0) && (!this.remote || current.version >= this.remote.version)) this.remote = current;
    this.update();
  }
  update() {
    const baseline = this.remote || this.note;
    this.field.disabled = this.saving;
    const retrying = this.attempt && this.field.value === this.attempt.text;
    this.saveButton.disabled = this.saving || this.deleted || !this.field.value.trim() || (this.field.value === baseline.text && !retrying);
    this.saveButton.textContent = this.saving ? 'Сохраняем…' : this.remote ? 'Сохранить мой вариант' : 'Сохранить';
    this.cancelButton.disabled = this.saving;
    this.acceptButton.disabled = this.saving;
    const message = this.deleted ? 'Сообщение удалено на другом устройстве. Скопируй нужные правки перед отменой.'
      : this.error || (this.remote ? 'Сообщение изменено на другом устройстве. Сравни версии перед сохранением.' : '');
    if (this.feedback.textContent !== message) this.feedback.textContent = message;
    this.feedback.hidden = !message;
    this.element.querySelector('.edit-conflict').hidden = !this.remote || this.deleted;
    this.element.querySelector('.edit-remote-text').textContent = this.remote?.text || '';
  }
  async save() {
    if (this.saving || this.saveButton.disabled || this.closed || !this.field.reportValidity()) return;
    const text = this.field.value;
    const version = (this.remote || this.note).version ?? 0;
    this.attempt = {text, version};
    this.saving = true;
    this.error = '';
    this.update();
    try {
      const saved = await this.api('notes/' + this.id, 'PATCH', {text, version});
      if (this.closed) return;
      this.closed = true;
      this.onSaved(saved, this);
    } catch (error) {
      if (this.closed) return;
      this.error = error.message || 'Не удалось сохранить правки. Попробуй снова.';
      this.errorKind = error.kind;
      if (error.status === 409 && error.current) {
        this.remote = error.current;
        this.onConflict(error.current);
      }
      if (error.status === 410) { this.deleted = true; this.onGone(this.id); }
    } finally {
      this.saving = false;
      if (!this.closed) this.update();
    }
  }
}
window.TextdropEditor = TextdropEditor;
