import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blogCollection = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    heroImage: z.string().optional(),
    category: z.enum(['מיינדסט', 'השקעות', 'ביטקוין', "בלוקצ'יין", 'מדריך', 'כללי']).default('כללי'),
    tags: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

const guidesCollection = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    heroImage: z.string().optional(),
    order: z.number().default(99),
    draft: z.boolean().default(false),
  }),
});

export const collections = {
  blog: blogCollection,
  guides: guidesCollection,
};
