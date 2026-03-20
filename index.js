const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

exports.notchpayWebhook = functions.https.onRequest(async (req, res) => {
  try {
    const payload = req.body;

    console.log("📩 Webhook NotchPay reçu :", JSON.stringify(payload, null, 2));

    // ✅ Vérification paiement
    if (
      payload?.event !== "payment.complete" ||
      payload?.data?.status !== "complete"
    ) {
      return res.status(400).send("Paiement non confirmé");
    }

    // ✅ Données
    const uid = payload.data.metadata?.uid;
    const amount = parseInt(payload.data.amounts?.total ?? "0", 10);
    const reference = payload.data.reference;

    if (!uid || !amount || !reference) {
      console.log("❌ Champs manquants :", { uid, amount, reference });
      return res.status(400).send("Champs manquants");
    }

    const walletRef = db.collection("wallets").doc(uid);

    // 🔒 TRANSACTION (ULTRA IMPORTANT)
    await db.runTransaction(async (t) => {
      const snap = await t.get(walletRef);

      let currentBalance = 0;
      let processedRefs = [];

      if (snap.exists) {
        const data = snap.data();
        currentBalance = data.balance || 0;
        processedRefs = data.processedRefs || [];
      }

      // 🚫 éviter double paiement
      if (processedRefs.includes(reference)) {
        console.log(`⚠️ Paiement déjà traité : ${reference}`);
        return;
      }

      const newBalance = currentBalance + amount;

      t.set(walletRef, {
        balance: newBalance,
        processedRefs: [...processedRefs, reference],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    console.log(`✅ Wallet crédité: ${uid} +${amount}`);
    return res.status(200).send("OK");

  } catch (err) {
    console.error("❌ Erreur webhook :", err);
    return res.status(500).json({
      error: "Erreur serveur",
      details: err.message
    });
  }
});