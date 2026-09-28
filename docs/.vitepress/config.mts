import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Sole',
  description: 'From a local library to your first playable vibe.',
  cleanUrls: true,
  srcExclude: ['README.md'],
  head: [['meta', { name: 'theme-color', content: '#f4efe5' }]],
  themeConfig: {
    logo: '/record.svg',
    siteTitle: 'Sole',
    nav: [
      { text: 'Start', link: '/getting-started/' },
      { text: 'First play', link: '/guides/first-play' },
      { text: 'Worker', link: '/guides/worker' },
      { text: 'Help', link: '/reference/troubleshooting' }
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Overview', link: '/getting-started/' },
          { text: 'Local install', link: '/getting-started/local' },
          { text: 'Public deployment', link: '/getting-started/public-deployment' }
        ]
      },
      {
        text: 'Guides',
        items: [
          { text: 'First playable vibe', link: '/guides/first-play' },
          { text: 'Embedding workers', link: '/guides/worker' }
        ]
      },
      {
        text: 'Reference',
        items: [{ text: 'Troubleshooting', link: '/reference/troubleshooting' }]
      }
    ],
    search: { provider: 'local' },
    footer: { message: 'Your library stays yours.', copyright: 'MIT licensed' }
  }
})
