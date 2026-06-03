/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './app.js'],
  safelist: [
    'bg-green-500', 'bg-red-500', 'bg-purple-600',
    'border-green-500', 'border-red-500', 'border-purple-500', 'border-blue-500', 'border-orange-500', 'border-indigo-500',
    'text-green-300', 'text-red-300', 'text-green-600', 'text-red-600', 'text-yellow-600', 'text-blue-600', 'text-orange-600', 'text-purple-600',
    'bg-yellow-50', 'bg-red-50', 'bg-green-50', 'bg-blue-50',
    'border-yellow-200', 'border-red-200', 'border-green-200', 'border-blue-200'
  ],
  theme: { extend: {} },
  plugins: []
};
