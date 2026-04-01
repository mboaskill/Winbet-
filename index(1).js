const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// 🔐 Montants autorisés (sécurité anti-hack)
const allowedAmounts = [500, 1000, 2000, 5000, 10000];

// 💱 Conversion XAF → USD (approx)
const XAF_TO_USD = 600;

// 🔑 PAYPAL CLIENT & SECRET
const PAYPAL_CLIENT_ID = "siAZy0xwfCrpB0jSIPXW4MYalFvaSkB5tFKKAfPpdD96ZOlMcElwmMrgdnjyX06VdRujOdmx4js5t4cZNU";
const PAYPAL_SECRET = "EK6EGh9C1X7Lz8Er4dpjMiEwHYLpcUUQXzL_ivC3pMsKBa_RXHae4sVdBPTgDtnmxq6kQ8HVZovG4yDE";

// 🔹 Fonction pour récupérer access token PayPal
async function getAccessToken() {
  try {
    const response = await axios({
      url: "https://api-m.paypal.com/v1/oauth2/token",
      method: "post",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64")
      },
      data: "grant_type=client_credentials"
    });

    return response.data.access_token;
  } catch (err) {
    console.error("❌ getAccessToken PayPal:", err.response?.data || err);
    throw new Error("Impossible de récupérer access token PayPal");
  }
}

// =========================
// 🟡 CREATE PAYPAL ORDER
// =========================
exports.createPayPalOrder = functions.https.onRequest(async (req, res) => {
  try {
    const { amount } = req.body;

    // 🔐 Vérification utilisateur Firebase
    const idToken = req.headers.authorization?.split("Bearer ")[1];
    if (!idToken) return res.status(401).json({ error: "Non autorisé" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // 🔒 Validation montant
    if (!allowedAmounts.includes(amount)) return res.status(400).json({ error: "Montant invalide" });

    // 💱 Conversion en USD pour PayPal
    const usdAmount = (amount / XAF_TO_USD).toFixed(2);

    const accessToken = await getAccessToken();
    const reference = `tx_${Date.now()}`;

    const order = await axios({
      url: "https://api-m.paypal.com/v2/checkout/orders",
      method: "post",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      data: {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: usdAmount },
            custom_id: `${uid}|${amount}|${reference}`
          }
        ],
        application_context: {
          return_url: "https://mboaskill.cm?success=true",
          cancel_url: "https://mboaskill.cm?cancel=true"
        }
      }
    });

    const approveUrl = order.data.links.find(l => l.rel === "approve")?.href;
    if (!approveUrl) return res.status(500).json({ error: "Lien PayPal introuvable" });

    console.log("✅ Order créée :", reference);
    res.json({ url: approveUrl });

  } catch (err) {
    console.error("❌ createPayPalOrder:", err.response?.data || err);
    res.status(500).json({ error: "Erreur création PayPal" });
  }
});

// =========================
// 🟡 CAPTURE PAYPAL ORDER
// =========================
exports.capturePayPalOrder = functions.https.onRequest(async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) return res.status(400).json({ error: "orderID manquant" });

    const accessToken = await getAccessToken();
    const response = await axios({
      url: `https://api-m.paypal.com/v2/checkout/orders/${orderID}/capture`,
      method: "post",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    const data = response.data;
    if (data.status !== "COMPLETED") {
      console.log("❌ Paiement non complété");
      return res.json({ success: false });
    }

    const captureData = data.purchase_units[0];
    const custom = captureData.custom_id;
    if (!custom) return res.status(400).json({ error: "custom_id manquant" });

    const [uid, amountStr, reference] = custom.split("|");
    const amount = parseFloat(amountStr);
    if (!uid || !amount || !reference) return res.status(400).json({ error: "Données invalides" });

    const walletRef = db.collection("wallets").doc(uid);

    // 🔒 Transaction sécurisée
    await db.runTransaction(async (t) => {
      const snap = await t.get(walletRef);
      let balance = 0;
      let processedRefs = [];

      if (snap.exists) {
        const d = snap.data();
        balance = d.balance || 0;
        processedRefs = d.processedRefs || [];
      }

      // 🚫 Anti double paiement
      if (processedRefs.includes(reference)) {
        console.log("⚠️ Déjà traité :", reference);
        return;
      }

      const newBalance = balance + amount;
      t.set(walletRef, {
        balance: newBalance,
        processedRefs: [...processedRefs, reference],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    console.log(`💰 PayPal crédité: ${uid} +${amount}`);
    res.json({ success: true });

  } catch (err) {
    console.error("❌ capturePayPalOrder:", err.response?.data || err);
    res.status(500).json({ success: false });
  }
});