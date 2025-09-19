// server.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.set('trust proxy', 1); // behind Render/Cloudflare
app.use(express.json());
app.use(helmet({ crossOriginResourcePolicy: false }));

// --- CORS allowlist ---
const allow = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allow.includes(origin)),
}));

// ---------- i18n helpers ----------
/** Map storefront language codes (e.g. "ja", "fr", "pt-PT") to our supported keys */
function pickLang(code) {
  const base = String(code || "").toLowerCase();
  const short = base.split("-")[0]; // e.g. "pt" from "pt-PT"
  const supported = [
    "en","ja","de","nl","ko","he","cs","pl","es","it","nb","da","el",
    "fr","pt-pt","sl","hu","fi","sv"
  ];
  if (supported.includes(base)) return base;
  if (supported.includes(short)) return short === "pt" ? "pt-pt" : short;
  return "en";
}

function fmtDateISOToLocale(iso, lang) {
  try { return new Date(iso).toLocaleDateString(lang || "en"); }
  catch { return iso || ""; }
}

function formatMoneyCents(cents, currency, lang) {
  try {
    return new Intl.NumberFormat(lang || "en", {
      style: "currency",
      currency
    }).format((cents || 0) / 100);
  } catch {
    return `${currency} ${(cents/100).toFixed(2)}`;
  }
}

/**
 * Minimal translation dictionary.
 * We keep templates short & clear. If you add more languages later,
 * just add a new key with the same structure (receivedSubject/receivedText/acceptedSubject/acceptedHtml/declinedSubject/declinedHtml).
 */
const M = {
  en: {
    receivedSubject: t => `We received your offer – ${t}`,
    receivedText: (amount, t) =>
      `Thanks! Your offer of ${amount} for “${t}” was received. We’ll get back to you soon.`,

    acceptedSubject: t => `Your offer was accepted – ${t}`,
    acceptedHtml: ({ amount, title, variantTitle, code, endsAt, withItem, applyOnly }) => `
      <p>Great news — we’ve accepted your offer of <b>${amount}</b> for <b>${title}</b>${variantTitle ? ` (${variantTitle})` : ""}.</p>
      <p>Your single-use discount code${endsAt ? ` (valid until <b>${endsAt}</b>)` : ""}:</p>
      <p style="font-size:18px"><b>${code}</b></p>
      <ul>
        <li><a href="${withItem}">Add the item and apply the code</a></li>
        <li><a href="${applyOnly}">Apply the code and go to your cart</a></li>
      </ul>
      <p>If the link doesn’t open, copy the code above and enter it at checkout.</p>`,

    declinedSubject: t => `Offer update – ${t}`,
    declinedHtml: t =>
      `<p>Thanks for your offer on <b>${t}</b>. We can’t accept that amount right now. Feel free to reply with a revised offer.</p>`
  },

  ja: {
    receivedSubject: t => `ご提案を受け付けました – ${t}`,
    receivedText: (amount, t) =>
      `ご提案ありがとうございます。「${t}」に対するご希望価格 ${amount} を受け付けました。担当者より折り返しご連絡いたします。`,

    acceptedSubject: t => `ご提案が承認されました – ${t}`,
    acceptedHtml: ({ amount, title, variantTitle, code, endsAt, withItem, applyOnly }) => `
      <p>朗報です。<b>${title}</b>${variantTitle ? `（${variantTitle}）` : ""} に対する <b>${amount}</b> のご提案を承認しました。</p>
      <p>単回利用の割引コード${endsAt ? `（有効期限：<b>${endsAt}</b>）` : ""}：</p>
      <p style="font-size:18px"><b>${code}</b></p>
      <ul>
        <li><a href="${withItem}">アイテムを追加してコードを適用</a></li>
        <li><a href="${applyOnly}">コードを適用してカートへ</a></li>
      </ul>
      <p>リンクが開けない場合は、上記コードをコピーしてチェックアウトで入力してください。</p>`,

    declinedSubject: t => `ご提案について – ${t}`,
    declinedHtml: t =>
      `<p><b>${t}</b> へのご提案ありがとうございます。現時点では承認できませんでした。別の価格で再度ご提案ください。</p>`
  },

  // (Other languages unchanged for brevity—your previous list remains)
  de: {
    receivedSubject: t => `Angebot erhalten – ${t}`,
    receivedText: (a,t)=>`Danke! Ihr Angebot über ${a} für „${t}“ ist eingegangen. Wir melden uns bald.`,
    acceptedSubject: t => `Angebot angenommen – ${t}`,
    acceptedHtml: p => `
      <p>Gute Nachrichten — Ihr Angebot von <b>${p.amount}</b> für <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} wurde angenommen.</p>
      <p>Einmaliger Rabattcode${p.endsAt?` (gültig bis <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Artikel hinzufügen und Code anwenden</a></li>
      <li><a href="${p.applyOnly}">Code anwenden und zum Warenkorb</a></li></ul>
      <p>Falls der Link nicht öffnet, Code beim Checkout eingeben.</p>`,
    declinedSubject: t => `Update zum Angebot – ${t}`,
    declinedHtml: t => `<p>Danke für Ihr Angebot zu <b>${t}</b>. Aktuell können wir es nicht annehmen. Gern können Sie einen neuen Vorschlag senden.</p>`
  },
  "zh-cn": {
  receivedSubject: t => `已收到您的出价 – ${t}`,
  receivedText: (a, t) => `谢谢！我们已收到您对“${t}”的出价 ${a}。我们会尽快与您联系。`,

  acceptedSubject: t => `出价已接受 – ${t}`,
  acceptedHtml: p => `
    <p>好消息——我们已接受您对 <b>${p.title}</b>${p.variantTitle ? `（${p.variantTitle}）` : ""} 的 <b>${p.amount}</b> 出价。</p>
    <p>一次性优惠码${p.endsAt ? `（有效期至 <b>${p.endsAt}</b>）` : ""}：</p>
    <p style="font-size:18px"><b>${p.code}</b></p>
    <ul>
      <li><a href="${p.withItem}">将商品加入购物车并应用优惠码</a></li>
      <li><a href="${p.applyOnly}">仅应用优惠码并前往购物车</a></li>
    </ul>
    <p>如果链接无法打开，请在结账时手动输入该优惠码。</p>`,

  declinedSubject: t => `出价更新 – ${t}`,
  declinedHtml: t =>
    `<p>感谢您对 <b>${t}</b> 的出价。目前我们无法接受该金额。如需调整价格，欢迎再次出价。</p>`
  },
  nl: {
    receivedSubject: t => `Aanbod ontvangen – ${t}`,
    receivedText: (a,t)=>`Bedankt! Uw bod van ${a} voor “${t}” is ontvangen. We nemen spoedig contact op.`,
    acceptedSubject: t => `Bod geaccepteerd – ${t}`,
    acceptedHtml: p => `
      <p>Goed nieuws — uw bod van <b>${p.amount}</b> voor <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} is geaccepteerd.</p>
      <p>Eenmalige kortingscode${p.endsAt?` (geldig tot <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Artikel toevoegen en code toepassen</a></li>
      <li><a href="${p.applyOnly}">Code toepassen en naar winkelwagen</a></li></ul>
      <p>Werkt de link niet? Kopieer de code en voer deze in bij het afrekenen.</p>`,
    declinedSubject: t => `Update bod – ${t}`,
    declinedHtml: t => `<p>Bedankt voor uw bod op <b>${t}</b>. We kunnen dit bedrag nu niet accepteren. U mag een aangepast bod sturen.</p>`
  },
  ko: {
    receivedSubject: t => `제안을 접수했습니다 – ${t}`,
    receivedText: (a,t)=>`감사합니다. “${t}”에 대한 제안가 ${a} 가 접수되었습니다. 곧 연락드리겠습니다.`,
    acceptedSubject: t => `제안이 승인되었습니다 – ${t}`,
    acceptedHtml: p => `
      <p><b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} 에 대한 <b>${p.amount}</b> 제안이 승인되었습니다.</p>
      <p>일회용 할인 코드${p.endsAt?` (유효기간: <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">상품 추가 후 코드 적용</a></li>
      <li><a href="${p.applyOnly}">코드 적용 후 장바구니로</a></li></ul>
      <p>링크가 열리지 않으면 체크아웃에서 코드를 입력하세요.</p>`,
    declinedSubject: t => `제안 안내 – ${t}`,
    declinedHtml: t => `<p><b>${t}</b>에 대한 제안 감사드립니다. 현재 가격으로는 승인하기 어렵습니다. 다른 가격으로 다시 제안해 주세요.</p>`
  },
  he: {
    receivedSubject: t => `הצעתך התקבלה – ${t}`,
    receivedText: (a,t)=>`תודה! ההצעה שלך על סך ${a} עבור „${t}” התקבלה. נחזור אליך בקרוב.`,
    acceptedSubject: t => `הצעתך אושרה – ${t}`,
    acceptedHtml: p => `
      <p>בשורה טובה — הצעתך על <b>${p.amount}</b> עבור <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} אושרה.</p>
      <p>קוד הנחה חד-פעמי${p.endsAt?` (בתוקף עד <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">הוסף את הפריט ויישם את הקוד</a></li>
      <li><a href="${p.applyOnly}">יישום קוד והמשך לעגלה</a></li></ul>
      <p>אם הקישור לא נפתח, העתק את הקוד הזן בקופה.</p>`,
    declinedSubject: t => `עדכון לגבי ההצעה – ${t}`,
    declinedHtml: t => `<p>תודה על ההצעה ל-<b>${t}</b>. בשלב זה לא נוכל לאשר. נשמח להצעה מעודכנת.</p>`
  },
  cs: {
    receivedSubject: t => `Nabídka přijata – ${t}`,
    receivedText: (a,t)=>`Děkujeme! Vaši nabídku ${a} na „${t}” jsme přijali. Brzy se ozveme.`,
    acceptedSubject: t => `Nabídka přijata – ${t}`,
    acceptedHtml: p => `
      <p>Skvělé zprávy — nabídku <b>${p.amount}</b> na <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} jsme přijali.</p>
      <p>Jednorázový slevový kód${p.endsAt?` (platný do <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Přidat položku a použít kód</a></li>
      <li><a href="${p.applyOnly}">Použít kód a přejít do košíku</a></li></ul>
      <p>Pokud odkaz nefunguje, zadejte kód při pokladně.</p>`,
    declinedSubject: t => `Aktualizace nabídky – ${t}`,
    declinedHtml: t => `<p>Děkujeme za nabídku na <b>${t}</b>. V tuto chvíli ji nemůžeme přijmout. Pošlete prosím upravenou nabídku.</p>`
  },
  pl: {
    receivedSubject: t => `Otrzymaliśmy Twoją ofertę – ${t}`,
    receivedText: (a,t)=>`Dziękujemy! Twoja oferta ${a} dla „${t}” została przyjęta. Wkrótce się odezwiemy.`,
    acceptedSubject: t => `Oferta zaakceptowana – ${t}`,
    acceptedHtml: p => `
      <p>Dobra wiadomość — zaakceptowaliśmy Twoją ofertę <b>${p.amount}</b> na <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Jednorazowy kod rabatowy${p.endsAt?` (ważny do <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Dodaj produkt i zastosuj kod</a></li>
      <li><a href="${p.applyOnly}">Zastosuj kod i przejdź do koszyka</a></li></ul>
      <p>Jeśli link nie działa, wprowadź kod przy kasie.</p>`,
    declinedSubject: t => `Aktualizacja oferty – ${t}`,
    declinedHtml: t => `<p>Dziękujemy za ofertę na <b>${t}</b>. Obecnie nie możemy jej zaakceptować. Prosimy o nową propozycję ceny.</p>`
  },
  es: {
    receivedSubject: t => `Hemos recibido tu oferta – ${t}`,
    receivedText: (a,t)=>`¡Gracias! Hemos recibido tu oferta de ${a} por “${t}”. Te contactaremos pronto.`,
    acceptedSubject: t => `Tu oferta fue aceptada – ${t}`,
    acceptedHtml: p => `
      <p>Buenas noticias: aceptamos tu oferta de <b>${p.amount}</b> por <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Código de descuento de un solo uso${p.endsAt?` (válido hasta <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Añadir el artículo y aplicar el código</a></li>
      <li><a href="${p.applyOnly}">Aplicar el código e ir al carrito</a></li></ul>
      <p>Si el enlace no abre, copia el código y úsalo en el pago.</p>`,
    declinedSubject: t => `Actualización de oferta – ${t}`,
    declinedHtml: t => `<p>Gracias por tu oferta por <b>${t}</b>. No podemos aceptarla por ahora. Envía otra propuesta si quieres.</p>`
  },
  it: {
    receivedSubject: t => `Offerta ricevuta – ${t}`,
    receivedText: (a,t)=>`Grazie! La tua offerta di ${a} per “${t}” è stata ricevuta. Ti contatteremo presto.`,
    acceptedSubject: t => `Offerta accettata – ${t}`,
    acceptedHtml: p => `
      <p>Ottime notizie — abbiamo accettato la tua offerta di <b>${p.amount}</b> per <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Codice sconto monouso${p.endsAt?` (valido fino al <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Aggiungi l’articolo e applica il codice</a></li>
      <li><a href="${p.applyOnly}">Applica il codice e vai al carrello</a></li></ul>
      <p>Se il link non si apre, copia il codice e inseriscilo al checkout.</p>`,
    declinedSubject: t => `Aggiornamento offerta – ${t}`,
    declinedHtml: t => `<p>Grazie per la tua offerta su <b>${t}</b>. Al momento non possiamo accettarla. Inviaci pure una nuova proposta.</p>`
  },
  nb: {
    receivedSubject: t => `Tilbud mottatt – ${t}`,
    receivedText: (a,t)=>`Takk! Vi har mottatt tilbudet ditt på ${a} for «${t}». Vi tar kontakt snart.`,
    acceptedSubject: t => `Tilbud godtatt – ${t}`,
    acceptedHtml: p => `
      <p>Gode nyheter — tilbudet ditt på <b>${p.amount}</b> for <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} er godtatt.</p>
      <p>Engangsrabattkode${p.endsAt?` (gyldig til <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Legg til varen og bruk koden</a></li>
      <li><a href="${p.applyOnly}">Bruk koden og gå til handlekurv</a></li></ul>
      <p>Åpner ikke lenken? Skriv inn koden i kassen.</p>`,
    declinedSubject: t => `Oppdatering om tilbud – ${t}`,
    declinedHtml: t => `<p>Takk for tilbudet på <b>${t}</b>. Vi kan ikke godta det nå. Send gjerne et nytt tilbud.</p>`
  },
  da: {
    receivedSubject: t => `Tilbud modtaget – ${t}`,
    receivedText: (a,t)=>`Tak! Vi har modtaget dit tilbud på ${a} for “${t}”. Vi vender tilbage snarest.`,
    acceptedSubject: t => `Tilbud accepteret – ${t}`,
    acceptedHtml: p => `
      <p>Gode nyheder — dit tilbud på <b>${p.amount}</b> for <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} er accepteret.</p>
      <p>Engangsrabatkode${p.endsAt?` (gyldig til <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Tilføj varen og brug koden</a></li>
      <li><a href="${p.applyOnly}">Brug koden og gå til kurv</a></li></ul>
      <p>Hvis linket ikke åbner, indtast koden ved checkout.</p>`,
    declinedSubject: t => `Opdatering om tilbud – ${t}`,
    declinedHtml: t => `<p>Tak for dit tilbud på <b>${t}</b>. Vi kan ikke acceptere det lige nu. Send gerne et nyt.</p>`
  },
  el: {
    receivedSubject: t => `Λάβαμε την προσφορά σας – ${t}`,
    receivedText: (a,t)=>`Ευχαριστούμε! Λάβαμε την προσφορά σας ${a} για «${t}». Θα επικοινωνήσουμε σύντομα.`,
    acceptedSubject: t => `Η προσφορά σας έγινε δεκτή – ${t}`,
    acceptedHtml: p => `
      <p>Καλά νέα — δεχτήκαμε την προσφορά <b>${p.amount}</b> για <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Μοναδικός κωδικός έκπτωσης${p.endsAt?` (ισχύει έως <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Προσθήκη προϊόντος & εφαρμογή κωδικού</a></li>
      <li><a href="${p.applyOnly}">Εφαρμογή κωδικού & μετάβαση στο καλάθι</a></li></ul>
      <p>Αν ο σύνδεσμος δεν ανοίγει, εισαγάγετε τον κωδικό στο ταμείο.</p>`,
    declinedSubject: t => `Ενημέρωση προσφοράς – ${t}`,
    declinedHtml: t => `<p>Ευχαριστούμε για την προσφορά στο <b>${t}</b>. Δεν μπορούμε να την αποδεχτούμε αυτή τη στιγμή. Μπορείτε να προτείνετε νέο ποσό.</p>`
  },
  fr: {
    receivedSubject: t => `Offre reçue – ${t}`,
    receivedText: (a,t)=>`Merci ! Nous avons bien reçu votre offre de ${a} pour « ${t} ». Nous revenons vers vous rapidement.`,
    acceptedSubject: t => `Offre acceptée – ${t}`,
    acceptedHtml: p => `
      <p>Bonne nouvelle — nous avons accepté votre offre de <b>${p.amount}</b> pour <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Code de réduction à usage unique${p.endsAt?` (valable jusqu’au <b>${p.endsAt}</b>)`:""} :</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Ajouter l’article et appliquer le code</a></li>
      <li><a href="${p.applyOnly}">Appliquer le code et aller au panier</a></li></ul>
      <p>Si le lien ne s’ouvre pas, copiez le code et saisissez-le au paiement.</p>`,
    declinedSubject: t => `Mise à jour de l’offre – ${t}`,
    declinedHtml: t => `<p>Merci pour votre offre concernant <b>${t}</b>. Nous ne pouvons pas l’accepter pour le moment. N’hésitez pas à nous proposer un autre montant.</p>`
  },
  "pt-pt": {
    receivedSubject: t => `Recebemos a sua proposta – ${t}`,
    receivedText: (a,t)=>`Obrigado! Recebemos a sua proposta de ${a} para “${t}”. Entraremos em contacto em breve.`,
    acceptedSubject: t => `Proposta aceite – ${t}`,
    acceptedHtml: p => `
      <p>Boas notícias — aceitámos a sua proposta de <b>${p.amount}</b> para <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Código de desconto de utilização única${p.endsAt?` (válido até <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Adicionar o artigo e aplicar o código</a></li>
      <li><a href="${p.applyOnly}">Aplicar o código e ir para o carrinho</a></li></ul>
      <p>Se o link não abrir, copie o código e introduza-o no checkout.</p>`,
    declinedSubject: t => `Atualização da proposta – ${t}`,
    declinedHtml: t => `<p>Obrigado pela sua proposta para <b>${t}</b>. De momento não a podemos aceitar. Envie-nos outra proposta, se desejar.</p>`
  },
  sl: {
    receivedSubject: t => `Ponudba prejeta – ${t}`,
    receivedText: (a,t)=>`Hvala! Vašo ponudbo ${a} za »${t}« smo prejeli. Kmalu vas kontaktiramo.`,
    acceptedSubject: t => `Ponudba sprejeta – ${t}`,
    acceptedHtml: p => `
      <p>Odlična novica — sprejeli smo vašo ponudbo <b>${p.amount}</b> za <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Enkratna koda za popust${p.endsAt?` (veljavna do <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Dodaj izdelek in uporabi kodo</a></li>
      <li><a href="${p.applyOnly}">Uporabi kodo in pojdi v košarico</a></li></ul>
      <p>Če se povezava ne odpre, vnesite kodo pri blagajni.</p>`,
    declinedSubject: t => `Posodobitev ponudbe – ${t}`,
    declinedHtml: t => `<p>Hvala za ponudbo za <b>${t}</b>. Trenutno je ne moremo sprejeti. Pošljite nam novo ponudbo, če želite.</p>`
  },
  hu: {
    receivedSubject: t => `Ajánlat megérkezett – ${t}`,
    receivedText: (a,t)=>`Köszönjük! Megkaptuk a(z) ${a} összegű ajánlatát a „${t}” termékre. Hamarosan jelentkezünk.`,
    acceptedSubject: t => `Ajánlat elfogadva – ${t}`,
    acceptedHtml: p => `
      <p>Jó hír — elfogadtuk <b>${p.amount}</b> összegű ajánlatát a <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""} termékre.</p>
      <p>Egyszer használható kedvezménykód${p.endsAt?` (érvényes eddig: <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Tétel hozzáadása és kód alkalmazása</a></li>
      <li><a href="${p.applyOnly}">Kód alkalmazása és kosár</a></li></ul>
      <p>Ha a link nem nyílik meg, írja be a kódot a fizetésnél.</p>`,
    declinedSubject: t => `Ajánlat frissítése – ${t}`,
    declinedHtml: t => `<p>Köszönjük az ajánlatot a <b>${t}</b> termékre. Jelenleg nem tudjuk elfogadni. Küldjön nyugodtan új ajánlatot.</p>`
  },
  fi: {
    receivedSubject: t => `Tarjous vastaanotettu – ${t}`,
    receivedText: (a,t)=>`Kiitos! Vastaanotimme tarjouksesi ${a} tuotteesta ”${t}”. Otamme pian yhteyttä.`,
    acceptedSubject: t => `Tarjous hyväksytty – ${t}`,
    acceptedHtml: p => `
      <p>Hyviä uutisia — hyväksyimme tarjouksesi <b>${p.amount}</b> tuotteesta <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Kertakäyttöinen alennuskoodi${p.endsAt?` (voimassa <b>${p.endsAt}</b> asti)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Lisää tuote ja käytä koodi</a></li>
      <li><a href="${p.applyOnly}">Käytä koodi ja siirry koriin</a></li></ul>
      <p>Jos linkki ei aukea, syötä koodi kassalla.</p>`,
    declinedSubject: t => `Tarjouksen päivitys – ${t}`,
    declinedHtml: t => `<p>Kiitos tarjouksestasi tuotteesta <b>${t}</b>. Emme voi hyväksyä sitä tällä hetkellä. Voit lähettää uuden ehdotuksen.</p>`
  },
  sv: {
    receivedSubject: t => `Erbjudande mottaget – ${t}`,
    receivedText: (a,t)=>`Tack! Vi har mottagit ditt erbjudande på ${a} för ”${t}”. Vi återkommer snart.`,
    acceptedSubject: t => `Erbjudande accepterat – ${t}`,
    acceptedHtml: p => `
      <p>Goda nyheter — vi har accepterat ditt erbjudande på <b>${p.amount}</b> för <b>${p.title}</b>${p.variantTitle?` (${p.variantTitle})`:""}.</p>
      <p>Engångsrabattkod${p.endsAt?` (giltig till <b>${p.endsAt}</b>)`:""}:</p>
      <p style="font-size:18px"><b>${p.code}</b></p>
      <ul><li><a href="${p.withItem}">Lägg till varan och använd koden</a></li>
      <li><a href="${p.applyOnly}">Använd koden och gå till kundvagnen</a></li></ul>
      <p>Om länken inte öppnas, ange koden i kassan.</p>`,
    declinedSubject: t => `Uppdatering om erbjudande – ${t}`,
    declinedHtml: t => `<p>Tack för ditt erbjudande på <b>${t}</b>. Vi kan inte acceptera det just nu. Skicka gärna ett nytt förslag.</p>`
  }
};
// ---------- end i18n helpers ----------

// --- SQLite (persistent disk) ---
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, "..", "data", "offers.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS offers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    shop_domain TEXT,
    product_id TEXT, product_handle TEXT, product_title TEXT,
    variant_id TEXT, variant_title TEXT,
    currency TEXT, price_cents INTEGER, offer_cents INTEGER,
    email TEXT, email_norm TEXT, note TEXT,
    lang TEXT,
    status TEXT DEFAULT 'open',
    discount_code TEXT,
    price_rule_id TEXT,
    discount_expires_at DATETIME,
    draft_order_id TEXT,
    drafted_at DATETIME,
    ip TEXT, ua TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_created ON offers(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_email_variant ON offers(email_norm,variant_id)`);
  // idempotent columns
  db.run(`ALTER TABLE offers ADD COLUMN lang TEXT`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN discount_code TEXT`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN price_rule_id TEXT`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN discount_expires_at DATETIME`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN draft_order_id TEXT`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN drafted_at DATETIME`, () => {});
});

// --- Mailer (optional) ---
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } : undefined
  });
}

// ---- Shopify helpers ----
const SHOP = process.env.SHOPIFY_SHOP; // yourstore.myshopify.com
const API_V = process.env.SHOPIFY_API_VERSION || "2025-07";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// REST
async function shopifyFetch(pathname, method = "GET", body = null) {
  if (!SHOP || !ADMIN_TOKEN) throw new Error("Shopify admin not configured");
  const url = `https://${SHOP}/admin/api/${API_V}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Shopify REST ${method} ${pathname} ${res.status}: ${text}`);
    throw new Error(`Shopify REST ${res.status}`);
  }
  return res.json();
}

// GraphQL
async function shopifyGraphQL(query, variables) {
  if (!SHOP || !ADMIN_TOKEN) throw new Error("Shopify admin not configured");
  const url = `https://${SHOP}/admin/api/${API_V}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("Shopify GQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }
  return json.data;
}

// --- Market mapping (domain -> currency & country) ---
const MARKET_MAP = (() => {
  try { return JSON.parse(process.env.MARKET_MAP_JSON || "[]"); } catch { return []; }
})();
function resolveMarketForHost(host) {
  const h = String(host || "").toLowerCase();
  const found = MARKET_MAP.find(m => m.host.toLowerCase() === h);
  if (found) return { currency: found.currency, country: found.country };
  if (h.endsWith(".jp")) return { currency: "JPY", country: "JP" };
  if (h.endsWith(".co.uk") || h.endsWith(".uk") || h.endsWith(".com")) return { currency: "GBP", country: "GB" };
  return { currency: "GBP", country: "GB" };
}

function getNumericId(maybeId) {
  const m = String(maybeId || "").match(/\d+$/);
  return m ? Number(m[0]) : NaN;
}
const toGID = (type, id) => `gid://shopify/${type}/${id}`;

/** Create code for a single accepted item (fixed amount, once per customer) */
async function createDiscountForOffer(row) {
  if (!row.price_cents || !row.offer_cents) throw new Error("Missing price/offer");
  const diffCents = Math.max(0, row.price_cents - row.offer_cents);
  if (diffCents <= 0) throw new Error("Offer >= price; no discount needed");

  const variantNumericId = getNumericId(row.variant_id);
  if (!variantNumericId) throw new Error(`Bad variant_id: ${row.variant_id}`);

  const valueFixed = `-${(diffCents / 100).toFixed(2)}`;
  const code = `OFFER-${row.id}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const startsAt = new Date().toISOString();
  const ttlDays = Number(process.env.DISCOUNT_TTL_DAYS || 7);
  const endsAt = new Date(Date.now() + ttlDays * 864e5).toISOString();

  const prBody = {
    price_rule: {
      title: `Offer ${row.id} – ${row.product_title}`,
      target_type: "line_item",
      target_selection: "entitled",
      allocation_method: "each",
      value_type: "fixed_amount",
      value: valueFixed,
      customer_selection: "all",
      starts_at: startsAt,
      ends_at: endsAt,
      usage_limit: 1,
      once_per_customer: true,
      entitled_variant_ids: [ variantNumericId ]
    }
  };

  const pr = await shopifyFetch(`/price_rules.json`, "POST", prBody);
  const priceRuleId = pr?.price_rule?.id;
  if (!priceRuleId) throw new Error("No price_rule.id returned");

  const dc = await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`, "POST", {
    discount_code: { code }
  });
  const createdCode = dc?.discount_code?.code || code;

  await new Promise((resolve, reject) => {
    db.run(
      "UPDATE offers SET discount_code=?, price_rule_id=?, discount_expires_at=? WHERE id=?",
      [createdCode, String(priceRuleId), endsAt, row.id],
      (err) => err ? reject(err) : resolve()
    );
  });

  return { code: createdCode, priceRuleId, endsAt };
}

/** Create a draft order priced in the customer's market currency (bundles multiple accepted offers) */
async function createDraftForEmailAndShop(emailNorm, shopDomain) {
  const rows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM offers
       WHERE email_norm=? AND shop_domain=? AND status='accepted'
         AND (draft_order_id IS NULL OR draft_order_id='')
       ORDER BY created_at ASC`,
      [emailNorm, shopDomain],
      (err, rs) => err ? reject(err) : resolve(rs || [])
    );
  });
  if (!rows.length) throw new Error("No accepted offers to draft");

  const { currency: presentmentCurrency, country } = resolveMarketForHost(shopDomain);
  const email = rows[0].email;

  const line_items = [];
  const ids = [];
  for (const r of rows) {
    const numeric = getNumericId(r.variant_id);
    if (!numeric) { console.error("Skip bad variant_id:", r.variant_id); continue; }
    line_items.push({
      variantId: toGID("ProductVariant", numeric),
      quantity: 1,
      priceOverride: {
        amount: (r.offer_cents / 100).toFixed(2),
        currencyCode: presentmentCurrency
      },
      customAttributes: [{ key: "OfferID", value: String(r.id) }]
    });
    ids.push(r.id);
  }
  if (!line_items.length) throw new Error("No valid line items from offers");

  const mutation = `
    mutation CreateDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl presentmentCurrencyCode }
        userErrors { field message }
      }
    }
  `;
  const input = {
    email,
    lineItems: line_items,
    presentmentCurrencyCode: presentmentCurrency,
    note: `Offers: ${ids.join(", ")} (market ${country}/${presentmentCurrency})`,
    tags: ["make-offer"]
  };

  const data = await shopifyGraphQL(mutation, { input });
  const payload = data?.draftOrderCreate;
  const gqlId = payload?.draftOrder?.id;
  if (!gqlId) {
    const errs = (payload?.userErrors || []).map(e => e.message).join("; ");
    throw new Error(`Draft create failed: ${errs || "no id"}`);
  }

  await new Promise((resolve, reject) => {
    const placeholders = ids.map(() => "?").join(",");
    db.run(
      `UPDATE offers SET draft_order_id=?, drafted_at=CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      [String(gqlId), ...ids],
      (err) => err ? reject(err) : resolve()
    );
  });

  try {
    const send = `
      mutation SendInvoice($id: ID!, $to: String!, $subject: String, $msg: String) {
        draftOrderInvoiceSend(id: $id, to: $to, subject: $subject, customMessage: $msg) {
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }
    `;
    await shopifyGraphQL(send, {
      id: gqlId,
      to: email,
      subject: "Your offer checkout",
      msg: "We’ve bundled the items you offered on. Complete checkout when ready."
    });
  } catch (e) {
    console.error("send_invoice failed:", e.message);
  }

  return { draftId: gqlId, count: ids.length, email, presentmentCurrency };
}

// --- Health + root page ---
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (req, res) => {
  res.send(`<!doctype html><meta charset="utf-8">
  <title>Offer Service</title>
  <style>body{font:14px system-ui;margin:40px;line-height:1.5}</style>
  <h2>Offer service is running ✅</h2>
  <p>Health: <a href="/health">/health</a></p>
  <p>Admin: <a href="/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">/admin/offers</a></p>`);
});

// --- Rate limit (proxy-safe) ---
const getClientIp = (req) => {
  const h = String(
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.ip || ''
  );
  return h.split(',')[0].trim();
};

const postLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
});

// --- Create offer ---
app.post("/api/offer", postLimiter, (req, res) => {
  const o = req.body || {};
  const origin = req.headers.origin || "";
  if (allow.length && !allow.includes(origin)) return res.status(403).json({ ok: false, error: "Forbidden origin" });

  const email = String(o.email || "").trim();
  if (!/^[^\s@]+@[^\s@]{1,}\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ ok: false, error: "Invalid email" });

  const product_id = String(o.product_id || "");
  const variant_id = String(o.variant_id || "");
  if (!product_id || !variant_id) return res.status(400).json({ ok: false, error: "Missing product/variant" });

  const offer_cents = Math.max(0, Math.round(parseFloat(o.offer || 0) * 100));
  if (!offer_cents) return res.status(400).json({ ok: false, error: "Offer required" });

  const row = {
    shop_domain: String(o.shop_domain || ""),
    product_id,
    product_handle: String(o.product_handle || ""),
    product_title: String(o.product_title || ""),
    variant_id,
    variant_title: String(o.variant_title || ""),
    currency: String(o.currency || "GBP"),
    price_cents: Math.max(0, parseInt(o.price_cents || 0, 10)),
    offer_cents,
    email,
    email_norm: email.toLowerCase(),
    note: String(o.note || "").slice(0, 2000),
    lang: String(o.lang || "").toLowerCase(),
    ip: getClientIp(req),
    ua: String(req.headers["user-agent"] || "")
  };

  db.get(
    `SELECT id FROM offers
     WHERE email_norm=? AND variant_id=? AND status='open'
       AND datetime(created_at) >= datetime('now','-1 day')`,
    [row.email_norm, row.variant_id],
    (err, exists) => {
      if (err) return res.status(500).json({ ok: false, error: "DB error" });
      if (exists) return res.status(429).json({ ok: false, error: "You already made an offer for this variant in the last 24 hours." });

      db.run(
        `INSERT INTO offers
         (shop_domain,product_id,product_handle,product_title,variant_id,variant_title,currency,price_cents,offer_cents,email,email_norm,note,lang,ip,ua)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.shop_domain,row.product_id,row.product_handle,row.product_title,row.variant_id,row.variant_title,row.currency,row.price_cents,row.offer_cents,row.email,row.email_norm,row.note,row.lang,row.ip,row.ua],
        function(insertErr){
          if (insertErr) return res.status(500).json({ ok: false, error: "Insert failed" });

          if (mailer && process.env.OFFER_TO_EMAIL) {
            const adminSubject = `New offer: ${row.currency} ${(row.offer_cents/100).toFixed(2)} – ${row.product_title} (${row.variant_title})`;
            const adminHtml = `
              <p><b>New offer received</b></p>
              <ul>
                <li>Product: ${row.product_title} (${row.product_handle})</li>
                <li>Variant: ${row.variant_title} (#${row.variant_id})</li>
                <li>Price: ${row.currency} ${(row.price_cents/100).toFixed(2)}</li>
                <li>Offer: <b>${row.currency} ${(row.offer_cents/100).toFixed(2)}</b></li>
                <li>Email: ${row.email}</li>
                <li>Note: ${row.note || "-"}</li>
                <li>Shop: ${row.shop_domain}</li>
                <li>Lang: ${row.lang || "-"}</li>
              </ul>
              <p><a href="/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Open admin</a></p>`;
            mailer.sendMail({ to: process.env.OFFER_TO_EMAIL, from: process.env.EMAIL_USER, subject: adminSubject, html: adminHtml }).catch(()=>{});

            // localized auto-reply
            const L = pickLang(row.lang);
            const dict = M[L] || M.en;
            const amount = formatMoneyCents(row.offer_cents, row.currency, L);
            mailer.sendMail({
              to: row.email,
              from: process.env.EMAIL_USER,
              subject: dict.receivedSubject(row.product_title),
              text: dict.receivedText(amount, row.product_title)
            }).catch(()=>{});
          }

          res.json({ ok: true, id: this.lastID });
        }
      );
    }
  );
});

// --- Admin table ---
app.get("/admin/offers", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  db.all("SELECT * FROM offers ORDER BY created_at DESC LIMIT 500", [], (err, rows) => {
    if (err) return res.status(500).send("DB error");
    const esc = s => String(s||"").replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    const tr = r => {
      const vid = getNumericId(r.variant_id);
      const codeLink = r.discount_code
        ? `<br><a href="https://${esc(r.shop_domain)}/discount/${encodeURIComponent(r.discount_code)}?redirect=%2Fcart%2Fadd%3Fid%3D${encodeURIComponent(vid)}%26quantity%3D1%26return_to%3D%252Fcart" target="_blank">Open with item</a>`
        : `<br><a href="/admin/offers/${r.id}/create-code?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Create code</a>`;
      const draftLink = (r.status === 'accepted')
        ? `<br><a href="/admin/offers/${r.id}/draft?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Draft for this email</a>`
        : "";
      return `<tr>
        <td>${r.id}</td><td>${r.created_at}</td>
        <td>${esc(r.product_title)}<br><small>${esc(r.variant_title)}</small></td>
        <td>${r.currency} ${(r.price_cents/100).toFixed(2)}</td>
        <td><b>${r.currency} ${(r.offer_cents/100).toFixed(2)}</b></td>
        <td>${esc(r.email)}${r.lang?`<br><small>Lang: ${esc(r.lang)}</small>`:""}</td>
        <td>${r.status}${r.discount_code ? `<br><small>Code: ${esc(r.discount_code)}</small>` : ""}${r.draft_order_id ? `<br><small>Draft: ${esc(r.draft_order_id)}</small>` : ""}</td>
        <td>
          <a href="/admin/offers/${r.id}/status?value=accepted&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Accept</a> ·
          <a href="/admin/offers/${r.id}/status?value=declined&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Decline</a> ·
          <a href="/admin/offers/${r.id}/status?value=open&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Reopen</a>
          ${codeLink}
          ${draftLink}
        </td></tr>`;
    };
    res.send(`<!doctype html><meta charset="utf-8"><title>Offers</title>
      <style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px}th{background:#f6f6f6}</style>
      <h2>Offers</h2>
      <table><tr><th>ID</th><th>Time</th><th>Product</th><th>Price</th><th>Offer</th><th>Email</th><th>Status</th><th>Action</th></tr>
      ${rows.map(tr).join("")}</table>`);
  });
});

// --- Manual retry: create code ---
app.get("/admin/offers/:id/create-code", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  const id = Number(req.params.id || 0);
  db.get("SELECT * FROM offers WHERE id=?", [id], async (err, row) => {
    if (err || !row) return res.status(404).send("Offer not found");
    try {
      if (!row.discount_code) await createDiscountForOffer(row);
    } catch (e) {
      console.error("Manual discount creation failed:", e.message);
    } finally {
      res.redirect(`/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}`);
    }
  });
});

// --- NEW: Create draft for this email (bundles multiple accepted offers) ---
app.get("/admin/offers/:id/draft", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  const id = Number(req.params.id || 0);
  db.get("SELECT * FROM offers WHERE id=?", [id], async (err, row) => {
    if (err || !row) return res.status(404).send("Offer not found");
    try {
      await createDraftForEmailAndShop(row.email_norm, row.shop_domain);
      if (mailer && row.email) {
        await mailer.sendMail({
          to: row.email,
          from: process.env.EMAIL_USER,
          subject: "Your offers are ready to checkout",
          html: `<p>We’ve created a checkout for your accepted items in your local currency. A Shopify invoice has been emailed to you.</p>`
        }).catch(()=>{});
      }
    } catch (e) {
      console.error("Draft order creation failed:", e.message);
    } finally {
      res.redirect(`/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}`);
    }
  });
});

// --- Accept/Decline (creates code on Accept + localized emails) ---
app.get("/admin/offers/:id/status", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  const id = Number(req.params.id || 0);
  const val = String(req.query.value || "open");
  if (!["open","accepted","declined","expired"].includes(val)) return res.status(400).send("Bad status");

  db.get("SELECT * FROM offers WHERE id=?", [id], async (err, row) => {
    if (err || !row) return res.status(404).send("Offer not found");

    db.run("UPDATE offers SET status=? WHERE id=?", [val, id], async (uerr) => {
      if (uerr) return res.status(500).send("DB error");

      // language setup for this customer
      const L = pickLang(row.lang);
      const dict = M[L] || M.en;

      if (val === "accepted") {
        let codeInfo = null;
        try {
          if (!row.discount_code) {
            codeInfo = await createDiscountForOffer(row);
          } else {
            codeInfo = { code: row.discount_code, priceRuleId: row.price_rule_id, endsAt: row.discount_expires_at };
          }
        } catch (e) {
          console.error("Discount creation failed:", e.message);
        }

        if (mailer && row.email) {
          try {
            const amount = formatMoneyCents(row.offer_cents, row.currency, L);
            const host = row.shop_domain || "smelltoimpress.com";
            const variantId = getNumericId(row.variant_id);

            const addPath   = `/cart/add?id=${encodeURIComponent(variantId)}&quantity=1&return_to=%2Fcart`;
            const withItem  = `https://${host}/discount/${encodeURIComponent(codeInfo?.code || "")}?redirect=${encodeURIComponent(addPath)}`;
            const applyOnly = `https://${host}/discount/${encodeURIComponent(codeInfo?.code || "")}?redirect=%2Fcart`;

            const endsAtStr = codeInfo?.endsAt ? fmtDateISOToLocale(codeInfo.endsAt, L) : "";

            await mailer.sendMail({
              to: row.email,
              from: process.env.EMAIL_USER,
              subject: dict.acceptedSubject(row.product_title),
              html: dict.acceptedHtml({
                amount,
                title: row.product_title,
                variantTitle: row.variant_title,
                code: codeInfo?.code || (L==="ja" ? "（お問い合わせください）" : "(contact us)"),
                endsAt: endsAtStr,
                withItem,
                applyOnly
              })
            });
          } catch (e) {
            console.error("Email on accept failed:", e.message);
          }
        }
      }

      if (val === "declined" && mailer && row.email) {
        try {
          await mailer.sendMail({
            to: row.email,
            from: process.env.EMAIL_USER,
            subject: dict.declinedSubject(row.product_title),
            html: dict.declinedHtml(row.product_title)
          });
        } catch(e){ console.error("Decline email failed:", e.message); }
      }

      res.redirect(`/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}`);
    });
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log("offer-service up on", port));