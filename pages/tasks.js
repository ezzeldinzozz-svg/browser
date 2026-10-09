'use strict';

let last = '';

async function refresh() {
  const tasks = await browserAPI.getTasks();
  const json = JSON.stringify(tasks);
  if (json === last) return;
  last = json;
  const total = tasks.reduce((n, t) => n + t.memoryMB, 0);
  document.getElementById('total').textContent = `${tasks.length} processes using ${total.toLocaleString()} MB in total.`;
  const body = document.querySelector('#tasks tbody');
  body.textContent = '';
  for (const t of tasks) {
    const tr = document.createElement('tr');
    const cells = [t.name, `${t.memoryMB.toLocaleString()} MB`, `${t.cpu}%`, String(t.pid)];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const action = document.createElement('td');
    if (t.canEnd) {
      const end = document.createElement('button');
      end.textContent = 'End process';
      end.title = 'Stops this tab; it shows a Reload button';
      end.addEventListener('click', () => browserAPI.endTask(t.pid));
      action.append(end);
    }
    tr.append(action);
    body.append(tr);
  }
}

refresh();
setInterval(refresh, 2000);
