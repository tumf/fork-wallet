'use strict';
// Vanilla EIP-1193 consumer. It never learns a key and never talks to an RPC endpoint directly.
const $ = (id) => document.getElementById(id);
const log = (text) => { const li = document.createElement('li'); li.textContent = text; $('events').append(li); };
let account = null;
let requests = 0;

function setConnected(value) {
  document.body.dataset.connected = String(value);
  $('send').disabled = !value;
  if (!value) { account = null; $('account').textContent = '-'; }
}

if (!window.ethereum) {
  $('status').textContent = 'no wallet';
} else {
  window.ethereum.on('accountsChanged', (accounts) => {
    log('accountsChanged ' + JSON.stringify(accounts));
    if (!accounts.length) setConnected(false);
    else if (account) { account = accounts[0]; $('account').textContent = account; }
  });
  window.ethereum.on('connect', async (info) => {
    log('connect ' + info.chainId);
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts.length) { account = accounts[0]; $('account').textContent = account; setConnected(true); }
  });
  window.ethereum.on('disconnect', (error) => {
    log('disconnect ' + error.code);
    setConnected(false);
  });
  $('connect').addEventListener('click', async () => {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      account = accounts[0];
      $('account').textContent = account;
      $('chain').textContent = await window.ethereum.request({ method: 'eth_chainId' });
      setConnected(true);
      $('status').textContent = 'connected';
    } catch (error) {
      $('status').textContent = 'error ' + error.code + ' ' + error.message;
    }
  });
  $('transfer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = ++requests;
    $('status').textContent = 'pending ' + id;
    document.body.dataset.request = String(id);
    try {
      const hash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: $('to').value, value: $('value').value }],
      });
      $('hash').textContent = hash;
      $('status').textContent = 'submitted ' + id;
    } catch (error) {
      $('status').textContent = 'error ' + id + ' ' + error.code + ' ' + error.message;
    }
  });
}
