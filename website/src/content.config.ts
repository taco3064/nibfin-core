import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

const loader = docsLoader();

export const collections = {
  docs: defineCollection({
    loader: {
      ...loader,
      async load(context) {
        await loader.load(context);
        if (process.env.NIBFIN_THEME_FIXTURE !== '1') context.store.delete('theme');
      },
    },
    schema: docsSchema(),
  }),
};
