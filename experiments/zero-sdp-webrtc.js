const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('console', m => console.log('page:', m.text()));
  const r = await p.evaluate(async () => {
    const fpOf = async c => c.getFingerprints().find(f => f.algorithm === 'sha-256').value.toUpperCase();
    // persistent certs (in real life: stored in IndexedDB, fingerprint in Beacon)
    const certA = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    const certB = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    const fpA = await fpOf(certA), fpB = await fpOf(certB);
    // ufrag/pwd "derived from shared DH secret" (here: constants)
    const cred = { A: ['aaaa', 'aaaaaaaaaaaaaaaaaaaaaaaa'], B: ['bbbb', 'bbbbbbbbbbbbbbbbbbbbbbbb'] };
    const tmpl = (u, pw, fp, setup) => [
      'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
      `a=ice-ufrag:${u}`, `a=ice-pwd:${pw}`, 'a=ice-options:trickle', `a=fingerprint:sha-256 ${fp}`,
      `a=setup:${setup}`, 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');
    const munge = (sdp, [u, pw]) => sdp.replace(/a=ice-ufrag:.*\r\n/, `a=ice-ufrag:${u}\r\n`).replace(/a=ice-pwd:.*\r\n/, `a=ice-pwd:${pw}\r\n`);
    const A = new RTCPeerConnection({ certificates: [certA] });
    const B = new RTCPeerConnection({ certificates: [certB] });
    const dA = A.createDataChannel('x', { negotiated: true, id: 0 });
    const dB = B.createDataChannel('x', { negotiated: true, id: 0 });
    const out = { letterCandidates: [] };
    // only B's candidates travel (one-way "Letter" B -> A); A's candidates are DISCARDED
    B.onicecandidate = e => { if (e.candidate && e.candidate.candidate) { out.letterCandidates.push(e.candidate.candidate); A.addIceCandidate(e.candidate).catch(x => out.err = String(x)); } };
    try {
      const offer = await A.createOffer(); await A.setLocalDescription({ type: 'offer', sdp: munge(offer.sdp, cred.A) });
      await B.setRemoteDescription({ type: 'offer', sdp: tmpl(...cred.A, fpA, 'actpass') }); // B synthesizes A's offer locally
      const ans = await B.createAnswer(); await B.setLocalDescription({ type: 'answer', sdp: munge(ans.sdp, cred.B) });
      await A.setRemoteDescription({ type: 'answer', sdp: tmpl(...cred.B, fpB, 'active') }); // A synthesizes B's answer locally
    } catch (e) { return { fail: String(e) }; }
    const ok = await Promise.race([
      new Promise(r => dB.onopen = () => { dB.send('hello over 0-SDP'); }).then(()=>0),
      new Promise(r => dA.onmessage = m => r(m.data)),
      new Promise(r => setTimeout(() => r('TIMEOUT ' + A.iceConnectionState + '/' + B.iceConnectionState), 10000))]);
    out.result = ok; return out;
  });
  console.log(JSON.stringify(r, null, 1)); await b.close();
})();
