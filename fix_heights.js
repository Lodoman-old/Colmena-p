const fs = require('fs');
const file = 'src/web/js/app.js';
let c = fs.readFileSync(file, 'utf8');

// Remove all inline height:42px and padding from selects/inputs inside labels in forms
// These conflict with the CSS and cause squished appearance
// Pattern: style="width:100%;height:42px;box-sizing:border-box;padding:0 10px;margin-bottom:0"
c = c.replace(/style="width:100%;height:42px;box-sizing:border-box;padding:0 10px;margin-bottom:0"/g, 'style="width:100%;box-sizing:border-box"');

// Also fix Lat/Lng inputs that got squished with width:100%
c = c.replace(/<input type="number" id="f-lat" placeholder="Lat" step="any" value="(\$\{[^}]+\})" style="width:100%;height:42px;box-sizing:border-box">/g,
  '<input type="number" id="f-lat" placeholder="Lat" step="any" value="$1" style="flex:1;box-sizing:border-box">');
c = c.replace(/<input type="number" id="f-lng" placeholder="Lng" step="any" value="(\$\{[^}]+\})" style="width:100%;height:42px;box-sizing:border-box">/g,
  '<input type="number" id="f-lng" placeholder="Lng" step="any" value="$1" style="flex:1;box-sizing:border-box">');

// Fix Votantes extra input
c = c.replace(/style="flex:none;width:100%;height:42px;box-sizing:border-box;text-align:center;padding:0;margin-bottom:0"/g,
  'style="flex:none;width:60px;box-sizing:border-box;text-align:center"');

fs.writeFileSync(file, c, 'utf8');
console.log('Done: removed inline heights, fixed Lat/Lng');
