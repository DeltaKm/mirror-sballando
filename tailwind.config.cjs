/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0e0e10',
        stage: '#171719',
        accent: '#ffc845',
        electric: '#2de2e6'
      }
    }
  },
  plugins: []
};
