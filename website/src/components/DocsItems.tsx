import { ArrowRight, type LucideIcon } from 'lucide-react';
import {
  Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle,
} from './ui/item';

interface Props {
  links: { title: string; href: string; Icon?: LucideIcon; description: string }[];
  columns?: 1 | 2;
}

export default function DocsItems({ links, columns = 1 }: Props) {
  const classes = columns === 2 ? 'nf-doc-links nf-doc-links-grid' : 'nf-doc-links';

  return (
    <div className="not-content">
      <ItemGroup className={classes + " grid"}>
        {links.map(({ title, href, Icon, description }) => (
          <div key={href} role="listitem">
            <Item className="nf-doc-link" asChild>
              <a href={href}>
                {Icon && <ItemMedia className="nf-doc-link-icon">
                  <Icon size={20} aria-hidden="true" />
                </ItemMedia>}
                <ItemContent className="min-w-0">
                  <ItemTitle className="nf-doc-link-title">{title}</ItemTitle>
                  <ItemDescription className="line-clamp-none text-wrap">
                    {description}
                  </ItemDescription>
                </ItemContent>
                <ArrowRight size={17} aria-hidden="true" className="shrink-0" />
              </a>
            </Item>
            <ItemSeparator className="bg-border-subtle" />
          </div>
        ))}
      </ItemGroup>
    </div>
  );
}
