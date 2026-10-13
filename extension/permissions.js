document.getElementById('grant').onclick = async () => {
  const status = document.getElementById('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = 'Microphone allowed. You can close this tab.';
  } catch (err) {
    status.textContent = `Not allowed: ${err.message}. Check chrome://settings/content/microphone.`;
  }
};
