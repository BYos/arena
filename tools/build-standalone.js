// Builds a single self-contained HTML (offline practice vs bots) – no server needed.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'shared/engine.js'), 'utf8');
html = html.replace(/<!--SOCKET-->[\s\S]*?<!--\/SOCKET-->/, '')
           .replace(/<!--ENGINE-->[\s\S]*?<!--\/ENGINE-->/, () => '<script>\n' + engine + '\n</script>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/arena-eat-offline.html'), html);
console.log('Built dist/arena-eat-offline.html');
