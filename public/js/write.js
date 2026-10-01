/* Write affordances: the upload panel, drag and drop, and confirmations. */
(() => {
  'use strict';

  const MAX_BYTES = 5 * 1024 * 1024;
  const humanSize = (bytes) => (bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

  /* ------------------------------------------------- destructive actions */

  // One confirmation handler for every form that carries a data-confirm, so a
  // delete can never happen on a stray click.
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-confirm]');
    if (!form) return;
    if (!window.confirm(form.getAttribute('data-confirm'))) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  /* ------------------------------------------------------- upload panel */

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-upload-toggle]');
    if (!toggle) return;
    const panel = document.querySelector('[data-upload-panel]');
    if (panel) panel.hidden = !panel.hidden;
  });

  const fileInput = document.querySelector('.upload-drop input[type="file"]');
  const list = document.querySelector('[data-upload-list]');
  const drop = document.querySelector('.upload-drop');

  if (fileInput && list) {
    /* A <input type="file"> cannot be edited once chosen: the only way to drop
       one staged file is to rebuild the whole FileList from a DataTransfer, so
       the accepted set is mirrored here and pushed back on every change. */
    let accepted = [];

    const pushToInput = () => {
      const transfer = new DataTransfer();
      for (const file of accepted) transfer.items.add(file);
      fileInput.files = transfer.files;
    };

    const paint = () => {
      list.replaceChildren(...accepted.map((file, index) => {
        const row = document.createElement('div');
        const tooBig = file.size > MAX_BYTES;
        row.className = `upload-item${tooBig ? ' is-too-big' : ''}`;

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = file.name;

        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = tooBig ? `${humanSize(file.size)} — too large` : humanSize(file.size);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'upload-remove';
        remove.dataset.uploadRemove = String(index);
        remove.title = `Remove ${file.name}`;
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>';

        row.append(name, size, remove);
        return row;
      }));
    };

    const accept = (files) => {
      accepted = [...files];
      paint();
      pushToInput();
    };

    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-upload-remove]');
      if (!button) return;
      accepted.splice(Number(button.dataset.uploadRemove), 1);
      paint();
      pushToInput();
    });

    fileInput.addEventListener('change', () => accept(fileInput.files));

    if (drop) {
      const over = (on) => drop.classList.toggle('is-over', on);
      ['dragenter', 'dragover'].forEach((type) =>
        drop.addEventListener(type, (event) => { event.preventDefault(); over(true); }));
      ['dragleave', 'drop'].forEach((type) =>
        drop.addEventListener(type, (event) => { event.preventDefault(); over(false); }));

      drop.addEventListener('drop', (event) => {
        const dropped = event.dataTransfer && event.dataTransfer.files;
        if (!dropped || !dropped.length) return;
        accept(dropped);
      });
    }
  }
})();
