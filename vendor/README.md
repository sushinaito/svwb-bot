# WB maker renderer

The user explicitly selected the visual output of https://sva.hypd.asia/maker/.
`scripts/prepare-maker.js` downloads a pinned copy of that site's browser renderer
and matching assets for the private deployment. `wbmaker.lock.json` records SHA-256
hashes. No live third-party service is called to render a user's card.

Original maker: Hypnos-PD, https://github.com/Hypnos-PD/wbmaker.
The renderer's upstream README credits Cygames for game frames/icons/fonts and
「欧丝的印卡机」 for effect-layout materials. Those assets retain their original rights.
The upstream repository does not declare an open-source license; do not represent
these third-party resources as our own or publish them as licensed source code.
Downloaded runtime and asset files are Git-ignored. The application/API adapter
and asset preparation script in this repository are our integration code.
