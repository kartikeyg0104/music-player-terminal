import React from 'react';
import { Box, Text } from 'ink';

/**
 * Element helpers.
 *
 * Termify runs straight from source with `node src/index.js` - no build step,
 * no transpiler - so the views are written with `createElement` shorthands
 * instead of JSX. `box(props, ...children)` and `text(props, ...children)`
 * read close enough to markup while keeping the package runnable as-is.
 */
export const h = React.createElement;

export const box = (props, ...children) => React.createElement(Box, props, ...children);
export const text = (props, ...children) => React.createElement(Text, props, ...children);

/** Fragment helper for lists of siblings. */
export const frag = (...children) => React.createElement(React.Fragment, null, ...children);

export { React, Box, Text };
