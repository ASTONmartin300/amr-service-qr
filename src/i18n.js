// English and Spanish for everything a resident can see. Language comes from
// ?lang=, else the phone's Accept-Language header, else English.
//
// Staff-facing text (the dispatch email, the dashboard) is English only --
// those are internal and mixing languages there just makes them harder to scan.
'use strict';

const STRINGS = {
  en: {
    htmlLang: 'en',
    brand: 'Aston Martin Residences',
    confirmTitle: 'How can we help?',
    confirmFor: 'for',
    confirmButton: 'Request service',
    confirmPrompt: 'Choose what needs attention',
    confirmNote: 'No name, unit number, or contact information is collected.',

    thanksTitle: 'Thank you.',
    thanksBody: 'The right team has been notified.',
    thanksNote: 'There is nothing else you need to do.',

    alreadyTitle: 'Thank you.',
    alreadyBody: 'This has already been reported and the right team has been notified.',
    alreadyNote: 'There is nothing else you need to do.',

    inactiveTitle: 'Not available',
    inactiveBody: 'This code is not currently active. Please contact the front desk.',

    unknownTitle: 'Code not recognized',
    unknownBody: 'Please contact the front desk for assistance.',

    errorTitle: 'Something went wrong',
    errorBody: 'Your request could not be submitted. Please notify the front desk.',

    switchLang: 'Español',
    switchTo: 'es',
  },
  es: {
    htmlLang: 'es',
    brand: 'Aston Martin Residences',
    confirmTitle: '¿Cómo podemos ayudar?',
    confirmFor: 'para',
    confirmButton: 'Solicitar servicio',
    confirmPrompt: 'Elija qué necesita atención',
    confirmNote: 'No se recopila nombre, número de unidad ni datos de contacto.',

    thanksTitle: 'Gracias.',
    thanksBody: 'Se ha notificado al equipo correspondiente.',
    thanksNote: 'No necesita hacer nada más.',

    alreadyTitle: 'Gracias.',
    alreadyBody: 'Esto ya fue reportado y se notificó al equipo correspondiente.',
    alreadyNote: 'No necesita hacer nada más.',

    inactiveTitle: 'No disponible',
    inactiveBody: 'Este código no está activo. Por favor comuníquese con la recepción.',

    unknownTitle: 'Código no reconocido',
    unknownBody: 'Por favor comuníquese con la recepción.',

    errorTitle: 'Ocurrió un problema',
    errorBody: 'No se pudo enviar su solicitud. Por favor avise a la recepción.',

    switchLang: 'English',
    switchTo: 'en',
  },
};

function pickLang(req, explicit) {
  if (explicit && STRINGS[explicit]) return explicit;
  const header = (req.headers['accept-language'] || '').toLowerCase();
  // Portuguese speakers land closer to Spanish than English, so route pt -> es.
  if (/^\s*(es|pt)\b/.test(header) || /[,;]\s*(es|pt)[-;,]/.test(header)) return 'es';
  return 'en';
}

function t(lang) {
  return STRINGS[lang] || STRINGS.en;
}

function label(location, lang) {
  if (!location) return '';
  return lang === 'es' ? location.label_es : location.label_en;
}

module.exports = { pickLang, t, label, STRINGS };
