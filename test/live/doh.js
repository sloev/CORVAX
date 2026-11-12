// Manual check (needs internet): DNS TXT through public DNS-over-HTTPS, as browsers use it.
import { defaultPlatform } from '../../src/peer.js'
const name = process.argv[2] || 'google.com'
const txt = await defaultPlatform().dnsTxt(name)
console.log(`TXT ${name}:`, txt.split('\n').length, 'records, e.g.', JSON.stringify(txt.split('\n')[0]))
process.exit(txt.length ? 0 : 1)
