// One-time microphone grant for the extension. On success it tells the panel
// (which then starts the recording the user asked for), goes back to the tab the
// user came from and closes itself.
const back = Number(new URLSearchParams(location.search).get('back')) || null;
document.getElementById('grant').onclick = async () => {
  const status = document.getElementById('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = 'Microphone allowed. Going back to your tab…';
    await chrome.runtime.sendMessage({ type: 'mic_granted' }).catch(() => {});
    if (back) await chrome.tabs.update(back, { active: true }).catch(() => {});
    const self = await chrome.tabs.getCurrent();
    setTimeout(() => self && chrome.tabs.remove(self.id), 600);
  } catch (err) {
    status.textContent = `Not allowed: ${err.message}. Check chrome://settings/content/microphone and allow it for TabHelm, then press the button again.`;
  }
};
