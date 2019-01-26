const ENV_VARIABLES = ['HOSTNAME', 'USERNAME', 'PASSWORD', 'PORT'];

module.exports = ENV_VARIABLES.reduce((acc, key) => {
  const value = process.env[key];
  if (value == null) throw new Error(`Missing enviromnent variable: ${key}`);

  return { ...acc, [key]: value };
}, {});
