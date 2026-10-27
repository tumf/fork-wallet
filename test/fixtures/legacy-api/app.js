// Legacy API fixture: a strict module script that does what older dApps do with an injected provider. During render it
// assigns autoRefreshOnNetworkChange = false (a TypeError on a frozen provider without the legacy accessor), and its
// connect action calls provider.enable(). Sends use the regular EIP-1193 request path.
const provider = window.ethereum;
const events = [];
window.legacyEvents = events;
for (const name of ['connect', 'disconnect', 'accountsChanged', 'chainChanged']) provider.on(name, (payload) => events.push([name, payload]));

provider.autoRefreshOnNetworkChange = false;
document.body.dataset.rendered = String(provider.autoRefreshOnNetworkChange);

const status = document.getElementById('status');
let seq = 0;
async function action(run) {
  const n = ++seq;
  try {
    status.textContent = `ok ${n} ${await run()}`;
  } catch (error) {
    status.textContent = `error ${n} ${error.code}`;
  }
  document.body.dataset.done = String(n);
}

document.getElementById('connect').addEventListener('click', () => action(async () => {
  const [account] = await provider.enable();
  document.getElementById('from').value = account;
  return account;
}));
document.getElementById('send').addEventListener('click', () => action(() => provider.request({
  method: 'eth_sendTransaction',
  params: [{ from: document.getElementById('from').value, to: document.getElementById('to').value, value: document.getElementById('value').value }],
})));
