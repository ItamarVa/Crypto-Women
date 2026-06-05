import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const sorted = posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  return rss({
    title: 'Crypto Women — בלוג',
    description: 'מאמרים ותובנות על ביטקוין, קריפטו, בלוקצ\'יין והשקעות מאת קרן ולדמן חנן',
    site: context.site ?? 'https://cryptowomen-il.com',
    customData: '<language>he</language>',
    items: sorted.map(post => ({
      title: post.data.title,
      pubDate: post.data.pubDate,
      description: post.data.description ?? '',
      link: `/blog/${post.id}/`,
    })),
  });
}
