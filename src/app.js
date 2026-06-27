import "./styles.css";

const demoFiles = [
  {
    filename_ai: "golden-retriever-playing.jpg",
    filename_original: "IMG_9042.jpg",
    size: 2100000,
    uploaded_from: "windows",
    created_at: new Date().toISOString()
  },
  {
    filename_ai: "project-proposal.pdf",
    filename_original: "Draft final final.pdf",
    size: 3700000,
    uploaded_from: "android",
    created_at: new Date(Date.now() - 86400000).toISOString()
  }
];

const app = document.querySelector("#app");

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function renderFile(file) {
  const uploadedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(file.created_at));

  return `
    <li class="file-row">
      <div>
        <strong>${file.filename_ai}</strong>
        <span>${file.filename_original}</span>
      </div>
      <div class="file-meta">
        <span>${formatBytes(file.size)}</span>
        <span>${file.uploaded_from}</span>
        <span>${uploadedAt}</span>
      </div>
      <div class="file-actions">
        <button type="button">Download</button>
        <button type="button" class="danger">Delete</button>
      </div>
    </li>
  `;
}

function render() {
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <h1>SyncDrop AI</h1>
        <nav>
          <button type="button">Upload</button>
          <button type="button">Refresh</button>
          <button type="button">Settings</button>
        </nav>
      </header>

      <section class="drop-zone" aria-label="File upload drop zone">
        <input id="file-input" type="file" multiple />
        <label for="file-input">
          <strong>Drop files here</strong>
          <span>or choose files to upload from this device</span>
        </label>
      </section>

      <section class="transfer-panel" aria-live="polite">
        <div>
          <strong>Ready</strong>
          <span>Supabase connection will be added in the integration phase.</span>
        </div>
        <progress value="0" max="100"></progress>
      </section>

      <section class="files">
        <h2>Files</h2>
        <ul>${demoFiles.map(renderFile).join("")}</ul>
      </section>
    </main>
  `;
}

render();
