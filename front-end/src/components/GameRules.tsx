import { type CatalogGameType, packageFor } from '../lib/gameRegistry';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover';

export function GameRules({ gameType }: { gameType: CatalogGameType }) {
  const { displayName, rules } = packageFor(gameType);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Rules?
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-96 max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto text-sm"
      >
        <PopoverTitle className="text-base">{displayName} rules</PopoverTitle>
        {rules.map(({ heading, items, ordered }) => {
          const List = ordered ? 'ol' : 'ul';
          return (
            <section key={heading} className="mt-3">
              <h3 className="font-semibold">{heading}</h3>
              <List className={`mt-1 space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
                {items.map((item) =>
                  typeof item === 'string' ? (
                    <li key={item}>{item}</li>
                  ) : (
                    <li key={item.text}>
                      {item.text}{' '}
                      <a
                        className="underline"
                        href={item.link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.link.label}
                      </a>
                    </li>
                  ),
                )}
              </List>
            </section>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
