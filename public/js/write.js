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
    const render = () => {
      const files = [...fileInput.files];
      list.replaceChildren(...files.map((file) => {
        const row = document.createElement('div');
        row.className = `upload-item${file.size > MAX_BYTES ? ' is-too-big' : ''}`;

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = file.name;

        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = file.size > MAX_BYTES
          ? `${humanSize(file.size)} — too large`
          : humanSize(file.size);

        row.append(name, size);
        return row;
      }));
    };

    fileInput.addEventListener('change', render);

    if (drop) {
      const over = (on) => drop.classList.toggle('is-over', on);
      ['dragenter', 'dragover'].forEach((type) =>
        drop.addEventListener(type, (event) => { event.preventDefault(); over(true); }));
      ['dragleave', 'drop'].forEach((type) =>
        drop.addEventListener(type, (event) => { event.preventDefault(); over(false); }));

      drop.addEventListener('drop', (event) => {
        const dropped = event.dataTransfer && event.dataTransfer.files;
        if (!dropped || !dropped.length) return;
        // Assigning to DataTransfer.files is the only way to make dropped
        // files appear in the input so they get submitted.
        const transfer = new DataTransfer();
        for (const file of dropped) transfer.items.add(file);
        fileInput.files = transfer.files;
        render();
      });
    }
  }
})();
