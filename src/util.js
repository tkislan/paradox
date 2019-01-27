function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepArrayEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

module.exports = {
  sleep,
  deepArrayEqual,
};
