'use strict';
// Private, account-scoped categories. Labels are always rendered as text.
class TextdropCategories {
  constructor({api, onFilter, onMarked, onError}) {
    Object.assign(this, {api, onFilter, onMarked, onError});
    this.catalog = []; this.filter = ''; this.epoch = 0; this.pending = false; this.note = null;
    this.$ = id => document.getElementById(id);
    const popup = this.$('category-picker');
    this.nativePopover = typeof popup.showPopover === 'function';
    if (!this.nativePopover) {popup.removeAttribute('popover'); popup.hidden = true; popup.classList.add('category-picker-fallback');}
    popup.addEventListener('toggle', event => {if (event.newState === 'closed') this.restoreFocus();});
    document.addEventListener('pointerdown', event => {
      if (!this.nativePopover && this.isOpen() && !popup.contains(event.target) && !this.trigger?.contains(event.target)) this.hidePicker();
    });
    document.addEventListener('keydown', event => {
      if (!this.nativePopover && event.key === 'Escape' && this.isOpen()) {event.preventDefault(); this.hidePicker(); this.restoreFocus();}
    });
    this.$('category-filter').onclick = () => this.openPicker(null, this.$('category-filter'));
    window.addEventListener('textdrop:before-update', event => {
      if (this.pending) {
        event.preventDefault(); event.detail.message = 'Подожди, пока категория сохранится.';
      }
    });
  }
  isOpen() { return this.nativePopover ? this.$('category-picker').matches(':popover-open') : !this.$('category-picker').hidden; }
  hidePicker() {
    if (this.nativePopover) this.$('category-picker').hidePopover(); else this.$('category-picker').hidden = true;
  }
  restoreFocus() {
    if (document.activeElement !== document.body) return;
    const target = this.note ? document.querySelector('.note[data-id="' + this.note.id + '"] [data-action="categories"]') : this.$('category-filter');
    target?.focus({preventScroll: true});
  }
  reset() {
    this.note = null; this.trigger = null;
    this.epoch++; this.catalog = []; this.filter = ''; this.note = null; this.pending = false;
    this.hidePicker();
    this.updateFilter();
  }
  accept(catalog) {
    const changed = JSON.stringify(catalog) !== JSON.stringify(this.catalog);
    if (!changed) return false;
    this.catalog = catalog;
    if (this.filter && !catalog.some(item => item.id === this.filter)) {this.filter = ''; this.onFilter();}
    this.updateFilter();
    if (this.isOpen()) this.renderPicker();
    return true;
  }
  label(category) { return category.emoji + ' ' + category.name; }
  button(label, handler, pressed) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.className = 'quiet'; button.onclick = handler;
    if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
    return button;
  }
  updateFilter() {
    const category = this.catalog.find(item => item.id === this.filter);
    this.$('category-filter-short').textContent = category?.emoji || '';
    this.$('category-filter').title = category ? this.label(category) : 'Категории';
    this.$('category-filter-label').textContent = category ? this.label(category) : 'Категории';
    this.$('category-filter').setAttribute('aria-label', category ? 'Фильтр: ' + this.label(category) : 'Фильтр по категориям');
    this.$('category-filter').setAttribute('aria-pressed', String(Boolean(category)));
  }
  selectFilter(id) {
    this.filter = id; this.updateFilter(); this.hidePicker(); this.onFilter();
  }
  openPicker(note, trigger) {
    this.hidePicker(); this.note = note; this.trigger = trigger;
    this.$('category-picker-title').textContent = note ? 'Категории сообщения' : 'Показать сообщения';
    this.renderPicker();
    const popup = this.$('category-picker');
    if (this.nativePopover) popup.showPopover(); else popup.hidden = false;
    const rect = trigger.getBoundingClientRect(), width = popup.getBoundingClientRect().width;
    popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
    const height = popup.getBoundingClientRect().height;
    popup.style.top = Math.max(8, Math.min(rect.bottom + 6, innerHeight - height - 8)) + 'px';
    popup.querySelector('button')?.focus();
  }
  renderPicker() {
    const list = this.$('category-choices'); list.replaceChildren();
    if (!this.note) list.append(this.button('Все сообщения', () => this.selectFilter(''), !this.filter));
    for (const category of this.catalog) {
      const active = this.note ? (this.note.categories || []).includes(category.id) : this.filter === category.id;
      const button = this.button(this.label(category), () => this.note ? this.mark(category) : this.selectFilter(category.id), active);
      button.disabled = this.pending; button.dataset.categoryId = category.id; list.append(button);
    }

    this.$('category-choices').setAttribute('aria-busy', String(this.pending));
    this.$('category-picker-feedback').textContent = '';
  }
  decorate(article, note, actions, readOnly) {
    if (this.note?.id === note.id && JSON.stringify(this.note) !== JSON.stringify(note)) {
      this.note = note; if (this.isOpen()) this.renderPicker();
    }
    if (!readOnly) {
      const add = this.button('', () => this.openPicker(note, add)); add.dataset.action = 'categories';
      add.setAttribute('aria-haspopup', 'true'); add.setAttribute('aria-controls', 'category-picker');
      add.setAttribute('aria-label', 'Категории сообщения'); add.title = 'Категории сообщения';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
      const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d','M3 3h7l11 11-7 7L3 10V3Zm4 4h.01'); svg.append(path); add.append(svg); actions.prepend(add);
    }
    const assigned = this.catalog.filter(category => (note.categories || []).includes(category.id));
    if (!assigned.length) return;
    const row = document.createElement('div'); row.className = 'category-reactions'; row.setAttribute('aria-label','Категории сообщения');
    for (const category of assigned) {
      const badge = this.button(this.label(category), () => readOnly ? this.selectFilter(category.id) : this.mark(category, note), true);
      badge.className = 'category-reaction'; badge.dataset.categoryId = category.id;
      badge.setAttribute('aria-label', (readOnly ? 'Показать категорию ' : 'Убрать категорию ') + this.label(category));
      badge.disabled = this.pending; row.append(badge);
    }
    article.append(row);
  }
  async mark(category, note = this.note) {
    if (this.pending || !note) return;
    const epoch = this.epoch, active = !(note.categories || []).includes(category.id);
    this.pending = true; this.renderPicker();
    try {
      const saved = await this.api('notes/' + note.id + '/categories/' + category.id, 'PATCH', {active});
      if (epoch !== this.epoch) return;
      if (this.note?.id === saved.id) this.note = saved;
      this.onMarked(saved);
      if (this.filter && !(saved.categories || []).includes(this.filter)) this.hidePicker();
    } catch (error) {
      if (epoch === this.epoch) {this.$('category-picker-feedback').textContent = error.message; this.onError(error);}
    } finally {
      if (epoch === this.epoch) {
        this.pending = false; this.renderPickerKeepingError(); this.onMarked(null);
        if (this.isOpen()) this.$('category-choices').querySelector('[data-category-id="' + category.id + '"]')?.focus({preventScroll: true});
      }
    }
  }
  renderPickerKeepingError() {
    const error = this.$('category-picker-feedback').textContent; this.renderPicker(); this.$('category-picker-feedback').textContent = error;
  }
}
window.TextdropCategories = TextdropCategories;
