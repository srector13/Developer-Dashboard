const md = require('markdown-it')();
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  console.log("Token MAP:", tokens[idx].map);
  return 'x\n';
};
md.render("\n\n```mermaid\ngraph TD\n```", { test: 123 });
