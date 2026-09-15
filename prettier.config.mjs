/**
 * SCOLAIRA Prettier configuration.
 * Tailwind plugin sorts classes consistently so visual styles are reproducible.
 */
const config = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindFunctions: ['cn', 'cva'],
};

export default config;
