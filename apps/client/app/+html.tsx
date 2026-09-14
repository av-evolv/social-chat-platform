import type { PropsWithChildren } from 'react';
import { ScrollViewStyleReset } from 'expo-router/html';

export default function Html({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Larynx — Your people, together</title>
        <meta name="description" content="A home for your conversations, plans, and shared moments. Larynx is in early development." />
        <meta name="theme-color" content="#F5F4EE" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
