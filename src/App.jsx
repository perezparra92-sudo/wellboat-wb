import { useState, useEffect, useCallback, useRef } from "react";

// ─── SUPABASE ────────────────────────────────────────────────────────────────
const SB_URL  = "https://iegwofgzemochrvrmqcw.supabase.co";
const SB_KEY  = "sb_publishable_4Qxy1DdDtdKthALoOUv3HQ_un7UfzcZ";
const SB_HDR  = { "Content-Type":"application/json", "apikey":SB_KEY, "Authorization":`Bearer ${SB_KEY}` };
async function dbRead() {
  const r = await fetch(`${SB_URL}/rest/v1/wb_data?id=eq.1`, { headers:{...SB_HDR,"Accept":"application/json"} });
  if (!r.ok) throw new Error("read");
  const rows = await r.json();
  if (!rows || rows.length===0) return { cargaDays:{}, notas:{}, solas:{}, cargaHorarios:{} };
  return rows[0].payload;
}
async function dbWrite(data) {
  const r = await fetch(`${SB_URL}/rest/v1/wb_data`, {
    method:"POST", headers:{...SB_HDR,"Prefer":"resolution=merge-duplicates"},
    body:JSON.stringify({id:1, payload:data}),
  });
  if (!r.ok) throw new Error("write");
}

const CLAVE = "8795"; // clave maestra

const C = {
  bg:"#080f1a", surface:"#0d1a2e", border:"#1a3050", borderB:"#0f2240",
  accent:"#0ea5e9", amber:"#f59e0b", red:"#ef4444", green:"#10b981",
  purple:"#8b5cf6", muted:"#4a6580", text:"#c8daf0", dim:"#6b85a0", white:"#e8f4ff",
};

const CATS = {
  HK:   { label:"Aseo/Orden",     color:"#10b981", bg:"rgba(16,185,129,.12)",  border:"rgba(16,185,129,.3)"  },
  MANT: { label:"Mantenimiento",   color:"#0ea5e9", bg:"rgba(14,165,233,.12)",  border:"rgba(14,165,233,.3)"  },
  LSA:  { label:"LSA / SOLAS",     color:"#f59e0b", bg:"rgba(245,158,11,.12)",  border:"rgba(245,158,11,.3)"  },
  FIFI: { label:"FIFI / CI",       color:"#ef4444", bg:"rgba(239,68,68,.12)",   border:"rgba(239,68,68,.3)"   },
  INS:  { label:"Inspección",      color:"#8b5cf6", bg:"rgba(139,92,246,.12)",  border:"rgba(139,92,246,.3)"  },
  INV:  { label:"Inventario",      color:"#f97316", bg:"rgba(249,115,22,.12)",  border:"rgba(249,115,22,.3)"  },
  OX:   { label:"Control Óxido",   color:"#e2e8f0", bg:"rgba(226,232,240,.08)", border:"rgba(226,232,240,.25)" },
  CARGA:{ label:"Carga/Descarga",  color:"#ef4444", bg:"rgba(239,68,68,.15)",   border:"rgba(239,68,68,.5)"   },
};

// Guardias reales: Día 1 (17-may) empezó con Camilo+Sergio en 20:00
// Ciclo: par/impar alternado
function guardiasDia(n) {
  const cs = "Camilo Canales + Sergio";
  const ud = "Ulises + David Cancino";
  // Día 1 (impar): CS empieza 20:00, UD en 04-12
  // Día 2 (par):   UD empieza en 04-12 también — patrón: impares=UD en 04-12, pares=CS en 04-12
  // Verificado: Día 2 (hoy) → UD 04-12 ✓
  if (n % 2 === 0) return { a:{t:"04:00–12:00",eq:ud}, b:{t:"12:00–20:00",eq:cs}, c:{t:"20:00–04:00",eq:ud} };
  return                  { a:{t:"04:00–12:00",eq:cs}, b:{t:"12:00–20:00",eq:ud}, c:{t:"20:00–04:00",eq:cs} };
}
function guardiaActual() {
  const h = new Date().getHours();
  if (h>=4&&h<12) return "04:00–12:00";
  if (h>=12&&h<20) return "12:00–20:00";
  return "20:00–04:00";
}

// ─── GUARDIAS DE NAVEGACIÓN ───────────────────────────────────────────────────
// 22:00-06:00 turno de navegación nocturna
// Tramo 1: 22:00-00:00 → 1 marino del equipo nocturno
// Tramo 2: 00:00-04:00 → 1 marino del equipo nocturno  
// Tramo 3: 04:00-06:00 → 1 marino del equipo que entra a las 04:00
// El otro marino del equipo 04:00 hace aseo comedor antes de 07:00

function guardiaNavegacion(diaNum) {
  const gs = guardiasDia(diaNum);
  // Equipo nocturno (20:00-04:00)
  const eqNocturno = gs.c.eq;
  // Equipo mañana (04:00-12:00) del día siguiente
  const gsNext = guardiasDia(diaNum + 1);
  const eqManana = gsNext.a.eq;
  return {
    tramo1: { hora:"22:00–00:00", equipo:eqNocturno, desc:"1 marino de guardia, 1 marino descansando" },
    tramo2: { hora:"00:00–04:00", equipo:eqNocturno, desc:"Relevo interno del mismo equipo" },
    tramo3: { hora:"04:00–06:00", equipo:eqManana,   desc:"1 marino guardia de navegación" },
    comedorManana: { hora:"06:00–07:00", equipo:eqManana, desc:"1 marino aseo comedor (obligatorio)" },
  };
}

// ─── CÁLCULO HORAS DISPONIBLES ────────────────────────────────────────────────
// Jornada base cubierta: 08:00-20:00 = 12 horas (sin contar guardias nocturnas)
// Si hay carga/descarga: descontar duración de operaciones
// Tareas por hora estimada: ~1 tarea cada 1.5-2 horas
function calcHorasDisponibles(operaciones) {
  const JORNADA_BASE = 10; // horas efectivas (descontando guardia navegación ~2h por equipo)
  let horasOcupadas = 0;
  // Handle both old format (single object) and new format (array)
  const ops = Array.isArray(operaciones) ? operaciones : (operaciones && operaciones.inicio ? [operaciones] : []);
  ops.forEach(op => {
    if (op.inicio && op.fin) {
      const [hI,mI] = op.inicio.split(":").map(Number);
      const [hF,mF] = op.fin.split(":").map(Number);
      let dur = (hF*60+mF) - (hI*60+mI);
      if (dur < 0) dur += 24*60;
      horasOcupadas += dur/60;
    } else if (op.inicio) {
      horasOcupadas += 3; // estimado si no hay hora de fin
    }
  });
  const disponible = Math.max(2, JORNADA_BASE - horasOcupadas);
  // 1 tarea cada ~1.5h, mínimo 2 tareas siempre
  const tareasMax = Math.max(2, Math.floor(disponible / 1.5));
  return { horasDisponibles: disponible.toFixed(1), tareasMax, horasOcupadas: horasOcupadas.toFixed(1) };
}

// Tarea fija del comedor — siempre aparece
const TAREA_COMEDOR = {
  id:"comedor_diario",
  t:"Aseo comedor (OBLIGATORIO antes de 07:00)",
  d:"El marino del equipo entrante 04:00 que no está de guardia de navegación realiza el aseo completo del comedor: mesas, sillas, suelo, bajo mesas, rejillas, inox al brillo. Listo antes de las 07:00.",
  cat:"HK",
  obligatorio: true,
};

const INICIO = new Date("2026-05-17");

// Día actual basado en fecha real (zona horaria local del dispositivo)
function diaActual() {
  const hoy = new Date();
  // Usar fecha local del dispositivo, no UTC
  const yy = hoy.getFullYear();
  const mm = hoy.getMonth();
  const dd = hoy.getDate();
  const hoyLocal = new Date(yy, mm, dd);
  const inicioLocal = new Date(2026, 4, 17); // 17 mayo 2026 (mes 4 = mayo)
  const diff = Math.floor((hoyLocal - inicioLocal) / (1000*60*60*24)) + 1;
  return Math.max(1, Math.min(25, diff));
}

function fechaDia(n) {
  const inicio = new Date(2026, 4, 17); // 17 mayo 2026 local
  const d = new Date(inicio);
  d.setDate(d.getDate() + n - 1);
  return d.toLocaleDateString("es-CL", { weekday:"long", day:"numeric", month:"long" });
}

const PLAN = [
{note:"Inicio de embarco. Orientación general del buque antes de cualquier trabajo.",
  alpha:[
    {id:"1a1",t:"Recorrida general del buque",d:"José Montecinos presenta al equipo todas las zonas: pañoles, cubierta de trabajo, sala RSW, vestíbulo, baños, equipos SOLAS y maquinaria de cubierta. Rutas de evacuación.",cat:"INS"},
    {id:"1a2",t:"Inventario pañol de proa",d:"Registrar cabos (diámetro y longitud), estrobos, grilletes, tensores, eslingas. Fotografiar estado actual. Anotar elementos deteriorados.",cat:"INV"},
    {id:"1a3",t:"Inventario pañol pinturas / SOPEP",d:"Listar pinturas, diluyentes y verificar completitud del kit SOPEP: absorbentes, barreras, pañoleta, guantes, bolsas residuos.",cat:"INV"},
  ],
  beta:[
    {id:"1b1",t:"Aseo profundo vestíbulo",d:"Barrer, lampazo, limpiar superficies, pasamanos, manillas y marcos de puertas. Limpiar luminarias. Revisar puertas estancas y sellos.",cat:"HK"},
    {id:"1b2",t:"Aseo profundo baño vestíbulo",d:"WC interior/exterior/cisterna, lavamanos, espejo, suelo, paredes, griferías, sifones. Desinfección completa. Inox al brillo. Reposición de insumos.",cat:"HK"},
    {id:"1b3",t:"Aseo profundo baño Castillo",d:"Mismo estándar baño vestíbulo. Limpiar rejillas de ventilación. Revisar drenajes. Reposición de insumos.",cat:"HK"},
  ]},
{note:"Inventario pañol de cubierta y aseo interior profundo — caja de escala.",
  alpha:[
    {id:"2a1",t:"Aseo profundo caja de escala",d:"Pasamanos: limpiar y tratar óxido superficial. Corners y rincones. Antideslizantes: cepillar y lavar. Mamparos: limpiar. Luminarias: despolvar y limpiar difusores.",cat:"HK"},
    {id:"2a2",t:"Inventario pañol de cubierta",d:"Clasificar y registrar herramientas: llaves, martillos, destornilladores, taladro, discos, extensiones, aceitera. Marcar herramientas en mal estado.",cat:"INV"},
    {id:"2a3",t:"Control óxido — pasamanos escala",d:"Detectar, marcar con tiza y picar óxido. Limpiar con grata o cepillo de acero. Aplicar WD-40 o lubricante protector temporal. Fotografiar para verano.",cat:"OX"},
  ],
  beta:[
    {id:"2b1",t:"Aseo pasillos exteriores alojamiento",d:"Barrer, lampazo con desengrasante. Limpiar manillas, marcos de puertas y ventanas exteriores. Luminarias exteriores. Revisar antideslizantes.",cat:"HK"},
    {id:"2b2",t:"Aseo profundo comedor",d:"Bajo mesas: limpiar polvo y suciedad acumulada. Rejillas de ventilación. Superficies inox al brillo. Dispensadores, refrigerador exterior. Sillas y bordes.",cat:"HK"},
    {id:"2b3",t:"Revisión visual escotillas wellboat",d:"Verificar estado de sellos de goma, herrajes y sistemas de cierre. Fotografiar deterioro. Reportar anomalías.",cat:"INS"},
  ]},
{note:"Aseo sala RSW y lavado sectorizado manifold y bandejas.",
  alpha:[
    {id:"3a1",t:"Aseo profundo sala RSW",d:"Pisos y paredes con desengrasante. Revisar filtraciones en tuberías y juntas. Limpiar drenajes y rejillas. Limpiar exterior de equipos de frío.",cat:"HK"},
    {id:"3a2",t:"Control óxido — sala RSW",d:"Detectar y marcar zonas oxidadas: piping, soportes, marcos. Picar con grata o needle gun. Aplicar protector temporal. Registrar y fotografiar.",cat:"OX"},
    {id:"3a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria obligatoria: barrer, lampazo y retirar cualquier residuo.",cat:"HK"},
  ],
  beta:[
    {id:"3b1",t:"Lavado sectorizado — manifold y bandejas",d:"Lavado con agua caliente y desengrasante del sector manifold, bandejas (drip trays), conexiones de flexibles. Retirar salitre y grasa. Secar y revisar fugas.",cat:"HK"},
    {id:"3b2",t:"Aseo baños y vestíbulo (rutina)",d:"Limpieza de rutina. Reposición de insumos.",cat:"HK"},
    {id:"3b3",t:"Limpieza imbornales y rejillas cubierta",d:"Despejar todos los scuppers y canalizaciones de cubierta. Verificar drenaje libre.",cat:"MANT"},
  ]},
{note:"Jueves: cubierta y control de óxido — handrails y bases de grúas.",
  alpha:[
    {id:"4a1",t:"Control óxido — handrails cubierta",d:"Recorrida sistemática de todos los handrails. Detectar, marcar, picar con grata. Limpiar y aplicar WD-40. Fotografiar.",cat:"OX"},
    {id:"4a2",t:"Revisión bote de rescate (1ª embarco)",d:"Inspección visual exterior. Revisión amarras y painter. Revisión drenajes. Revisión baterías visual. Verificación de inventario. Registrar en bitácora.",cat:"LSA"},
    {id:"4a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"4b1",t:"Control óxido — bases de grúas",d:"Inspección de las 4 bases de grúas. Detectar óxido activo, marcar, picar con grata/cepillo. Limpiar y aplicar protector temporal. Fotografiar.",cat:"OX"},
    {id:"4b2",t:"Lubricación winches cubierta de trabajo",d:"Limpiar sal y suciedad. Lubricar engranajes expuestos, revisar cable enrollado. Verificar mordazas.",cat:"MANT"},
    {id:"4b3",t:"Orden zona cubierta de trabajo",d:"Recoger y estibar herramientas y materiales. Clasificar lo que queda en cubierta.",cat:"HK"},
  ]},
{note:"Viernes: rutinas SOLAS/FIFI semanales — coordinación Ignacio Ulloa.",
  alpha:[
    {id:"5a1",t:"LSA semanal — chalecos salvavidas",d:"Conteo aleatorio. Revisión luces de inmersión. Revisión silbatos. Verificar orden en lockers. Registrar en planilla semanal. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"5a2",t:"LSA semanal — trajes de inmersión",d:"Revisión visual: estado exterior, cierre cremallera, guantes, capucha. Orden de almacenamiento. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"5a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"5b1",t:"FIFI semanal — estaciones de incendio",d:"Revisar mangueras: sin daños, enrollado correcto. Revisión boquillas/pitones. Limpieza de gabinetes CI. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"5b2",t:"FIFI semanal — extintores portátiles",d:"Verificar presión visual. Revisar sello. Verificar accesibilidad. Limpiar exterior. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"5b3",t:"Control óxido — bordes de escalas",d:"Detectar y tratar óxido en bordes y peldaños de escalas. Picar, limpiar y aplicar protector temporal.",cat:"OX"},
  ]},
{note:"Sábado: pañol de proa — Día 1 del método (vaciado y limpieza a fondo).",
  alpha:[
    {id:"6a1",t:"Pañol de proa — vaciado parcial y limpieza",d:"Sacar todos los cabos, estrobos y elementos sueltos. Limpiar el pañol por dentro: paredes, suelo, rincones, drenajes, luminarias. Con desengrasante donde haya grasa.",cat:"HK"},
    {id:"6a2",t:"Control óxido — interior pañol de proa",d:"Detectar y tratar zonas oxidadas en paredes y suelo del pañol. Picar, grata, limpiar y aplicar protector temporal.",cat:"OX"},
    {id:"6a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"6b1",t:"FIFI semanal — EEBD",d:"Revisión visual de presión de cada EEBD. Verificar accesibilidad de gabinetes. Limpiar exterior. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"6b2",t:"LSA semanal — balsas salvavidas",d:"Revisión del lanzamiento hidrostático: visual y estado. Verificar trinca correcta. Revisión de accesos y señalética. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"6b3",t:"Aseo baños y vestíbulo (rutina)",d:"Limpieza completa. Reposición de insumos.",cat:"HK"},
  ]},
{note:"Domingo: trabajo liviano, rondas y mantenimiento menor. Sin sobrecargar a la tripulación.",
  alpha:[
    {id:"7a1",t:"Ronda general de cubierta",d:"Inspección visual del estado general: equipos, cubierta, zonas de maniobra. Reportar novedades al 1° Oficial.",cat:"INS"},
    {id:"7a2",t:"Lubricación bisagras y limpieza de herramientas",d:"Lubricar bisagras de puertas y escotillas. Limpiar herramientas usadas en la semana. Adujar cabos correctamente.",cat:"MANT"},
    {id:"7a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"7b1",t:"FIFI semanal — alarma general y altavoces",d:"Prueba semanal del sistema de alarma general. Prueba de comunicación por altavoces. Registrar resultado. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"7b2",t:"FIFI semanal — puertas CI y luminarias emergencia",d:"Prueba de cierre de puertas CI: rieles y sellos. Prueba visual luminarias de emergencia. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"7b3",t:"Aseo baños y vestíbulo (rutina)",d:"Limpieza de rutina. Reposición de insumos.",cat:"HK"},
  ]},
{note:"Lunes semana 2. Aseo interior profundo — puente de mando y lockers.",
  alpha:[
    {id:"8a1",t:"Aseo profundo puente de mando",d:"Consolas y paneles: limpiar polvo y suciedad. Vidrios y acrílicos. Cielos. Sillas y superficies. Cajones y compartimentos. Alerones accesibles.",cat:"HK"},
    {id:"8a2",t:"Aseo lockers de abandono",d:"Vaciar, limpiar interior, verificar EPP (chalecos, trajes, bengalas), volver a ordenar correctamente. Etiquetar contenido.",cat:"LSA"},
    {id:"8a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"8b1",t:"Aseo lockers y cajones cubierta",d:"Vaciar, limpiar interior. Clasificar contenido. Etiquetar. Volver a estibar ordenadamente.",cat:"HK"},
    {id:"8b2",t:"Etiquetado y numeración pañoles",d:"Revisar y reponer etiquetas de identificación en pañoles, lockers, estanterías y racks.",cat:"HK"},
    {id:"8b3",t:"Revisión sistema de achique cubierta",d:"Verificar bombas de achique, acceso a sentinas y tapas de registro. Reportar a máquinas.",cat:"INS"},
  ]},
{note:"Martes: lavado sectorizado sector flexibles y conexiones wellboat.",
  alpha:[
    {id:"9a1",t:"Lavado sectorizado — sector flexibles y conexiones wellboat",d:"Lavado micro-sector con agua caliente y desengrasante: conexiones de traspaso, flexibles, accesorios. Salitre y grasa. Revisar estado de mangueras y acoples.",cat:"HK"},
    {id:"9a2",t:"Control óxido — marcos de puertas estancas",d:"Recorrida de marcos de puertas estancas. Detectar óxido, marcar, picar con grata/cepillo fino. Aplicar protector temporal. Fotografiar.",cat:"OX"},
    {id:"9a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"9b1",t:"Aseo estanterías y racks pañoles",d:"Limpiar estanterías y racks de todos los pañoles. Revisar estado estructural. Reorganizar contenido lógicamente. Etiquetar niveles.",cat:"HK"},
    {id:"9b2",t:"Aseo profundo baños y vestíbulo",d:"Limpieza profunda completa. Limpiar rincones, desagües, rejillas de ventilación. Inox al brillo.",cat:"HK"},
    {id:"9b3",t:"Revisión herrajes escotillas wellboat",d:"Inspeccionar perros de cierre, bisagras y sellos. Lubricar con grasa marina.",cat:"MANT"},
  ]},
{note:"Miércoles: instrucción SOLAS e inspecciones con Ignacio Ulloa.",
  alpha:[
    {id:"10a1",t:"Instrucción SOLAS — equipos de seguridad",d:"Ignacio Ulloa dirige instrucción práctica: ubicación y uso de equipos SOLAS. Procedimiento hombre al agua. Puntos de reunión y rutas de evacuación. Registrar en bitácora.",cat:"LSA"},
    {id:"10a2",t:"Aseo caja de escala — mantenimiento semanal",d:"Pasamanos, antideslizantes, corners y luminarias. Mantener el estándar.",cat:"HK"},
    {id:"10a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"10b1",t:"Lavado sectorizado — sector bombas wellboat",d:"Limpieza de suelo y paredes del sector de bombas. Limpiar exterior de bombas y piping. Revisar fugas y filtraciones.",cat:"HK"},
    {id:"10b2",t:"Control óxido — winches y maquinaria cubierta",d:"Detectar y tratar óxido en cuerpos de winches y maquinillas. Grata/cepillo de acero. Aplicar lubricante protector.",cat:"OX"},
    {id:"10b3",t:"Lubricación general — grilletes y aparejos",d:"Lubricar grilletes de uso frecuente, pastecas y motones con lubricante marino.",cat:"MANT"},
  ]},
{note:"Jueves: cubierta, grúas y control de óxido en tapas y bitts.",
  alpha:[
    {id:"11a1",t:"Revisión grúas (2ª visual — 4 unidades)",d:"Inspección visual de estructura, cables/eslingas de trabajo, ganchos, seguros y mandos. Lubricar puntos de engrase accesibles. Registrar.",cat:"MANT"},
    {id:"11a2",t:"Control óxido — tapas y escotillas cubierta",d:"Detectar óxido en tapas y poklines. Picar, grata, limpiar y aplicar protector. Fotografiar.",cat:"OX"},
    {id:"11a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"11b1",t:"Control óxido — bitts y cornamusas",d:"Recorrida completa de bitts y cornamusas. Detectar óxido, picar con grata. Limpiar y aplicar WD-40.",cat:"OX"},
    {id:"11b2",t:"Revisión cabrestante",d:"Limpieza de sal, revisión de freno y embrague. Lubricación. Inspección visual de cabo/cable de trabajo.",cat:"MANT"},
    {id:"11b3",t:"Revisión y estiba cabos de amarre",d:"Verificar estado de todos los cabos del juego de amarre. Clasificar: operativo / en observación / dar de baja.",cat:"INS"},
  ]},
{note:"Viernes: rutinas SOLAS/FIFI semanales (2ª semana) — Ignacio Ulloa.",
  alpha:[
    {id:"12a1",t:"LSA semanal — chalecos y trajes inmersión",d:"Conteo aleatorio chalecos. Revisión luces y silbatos. Revisión visual trajes: cremallera, guantes, capucha. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"12a2",t:"Control óxido — piping cubierta",d:"Inspección de piping expuesto en cubierta. Detectar óxido, picar, limpiar y aplicar protector temporal.",cat:"OX"},
    {id:"12a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"12b1",t:"FIFI semanal — estaciones CI, extintores, EEBD",d:"Revisión completa: mangueras, boquillas, gabinetes, presión extintores, sellos, accesibilidad EEBD. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"12b2",t:"FIFI semanal — puertas CI y luminarias emergencia",d:"Prueba de cierre, sellos y rieles. Prueba visual luminarias de emergencia. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"12b3",t:"Aseo baños y vestíbulo (rutina)",d:"Limpieza completa. Reposición de insumos.",cat:"HK"},
  ]},
{note:"Sábado: pañoles — clasificación e inventario pañol de proa y cubierta.",
  alpha:[
    {id:"13a1",t:"Pañol de proa — clasificación y orden",d:"Clasificar todo el contenido por categorías: cabos, estrobos, grilletes, tensores. Separar lo que va a dar de baja. Orden lógico.",cat:"HK"},
    {id:"13a2",t:"Pañol de proa — inventario y etiquetado",d:"Inventario completo con registro de cada ítem. Colocar etiquetas de identificación en estantes y racks.",cat:"INV"},
    {id:"13a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"13b1",t:"Pañol de cubierta — vaciado y limpieza",d:"Sacar todo el contenido. Limpiar el pañol por dentro: paredes, suelo, rincones, luminarias. Con desengrasante.",cat:"HK"},
    {id:"13b2",t:"Control óxido — interior pañol de cubierta",d:"Detectar y tratar óxido en el interior del pañol. Picar, grata, aplicar protector temporal.",cat:"OX"},
    {id:"13b3",t:"LSA semanal — balsas y señalética",d:"Revisión lanzamiento hidrostático. Verificar trinca. Revisión de accesos y señalética. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
  ]},
{note:"Domingo: trabajo liviano. Inspecciones mensuales SOLAS (1ª parte) — Ignacio Ulloa.",
  alpha:[
    {id:"14a1",t:"LSA mensual — bote de rescate",d:"Arranque del motor. Prueba de comunicaciones internas. Revisión detallada de inventario. Revisión visual de ganchos. Prueba de luces. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"14a2",t:"Ronda general de cubierta",d:"Inspección visual del estado general. Reportar novedades.",cat:"INS"},
    {id:"14a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"14b1",t:"FIFI mensual — bomba CI y bomba de emergencia",d:"Prueba operacional bomba CI principal: presión en líneas, fugas visibles. Arranque y prueba bomba de emergencia. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"14b2",t:"FIFI mensual — conexión de emergencia internacional",d:"Inspeccionar conexión internacional de socorro a incendios. Verificar junta y limpieza. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"14b3",t:"Aseo baños y vestíbulo (rutina)",d:"Limpieza de rutina. Reposición de insumos.",cat:"HK"},
  ]},
{note:"Día 15 — Punto medio del embarco. Gran limpieza general y consolidado de inventarios.",
  alpha:[
    {id:"15a1",t:"Gran aseo pañol de proa — orden final",d:"Orden final del pañol de proa: todo clasificado, etiquetado e inventariado. Listo para segunda mitad del embarco.",cat:"HK"},
    {id:"15a2",t:"Consolidado inventarios mid-embarco",d:"José Montecinos reúne todos los registros de inventario de los primeros 14 días y presenta informe al 1° Oficial.",cat:"INV"},
    {id:"15a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"15b1",t:"Gran lavado cubierta de trabajo",d:"Lavado completo con manguera y desengrasante de cubierta de trabajo y popa. Foco en zonas de alta suciedad y salitre.",cat:"HK"},
    {id:"15b2",t:"Aseo sala RSW (semanal)",d:"Limpieza completa de pisos, paredes y drenajes. Revisar estado de equipos de frío. Reportar a máquinas.",cat:"HK"},
    {id:"15b3",t:"Revisión EPP mid-embarco",d:"Segunda revisión del embarco: cascos, chalecos, guantes, calzado, arneses y líneas de vida. Actualizar planilla. (Coord. Ignacio Ulloa)",cat:"LSA"},
  ]},
{note:"Lunes semana 4. Aseo interior profundo y zona popa. Preparativos para el relevo.",
  alpha:[
    {id:"16a1",t:"Aseo puente — mantenimiento semanal",d:"Limpiar consolas, paneles, vidrios y superficies del puente. Mantener el estándar.",cat:"HK"},
    {id:"16a2",t:"Control óxido — zona popa",d:"Recorrida de zona popa: cubierta, bitas, guías, estructuras. Detectar, marcar y tratar óxido activo.",cat:"OX"},
    {id:"16a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"16b1",t:"Lavado sectorizado — zona popa completa",d:"Lavado micro-sector zona popa: cubierta popa, bitas, cornamusas, estructuras y scuppers. Agua caliente y desengrasante.",cat:"HK"},
    {id:"16b2",t:"Aseo profundo baños y vestíbulo",d:"Limpieza profunda completa. Inox al brillo. Reposición de insumos.",cat:"HK"},
    {id:"16b3",t:"Lubricación winches (2ª del embarco)",d:"Segunda lubricación del embarco. Revisar estado del cable enrollado.",cat:"MANT"},
  ]},
{note:"Martes: aseo interior y instrucción en maniobras de cubierta.",
  alpha:[
    {id:"17a1",t:"Instrucción maniobras — equipo de cubierta",d:"José Montecinos dirige: repaso de nudos marinos, eslingado correcto y señales de comunicación con grúa. Práctica supervisada.",cat:"INS"},
    {id:"17a2",t:"Aseo caja de escala — profundo",d:"Mantenimiento semanal profundo. Antideslizantes, corners, luminarias.",cat:"HK"},
    {id:"17a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"17b1",t:"Lavado sectorizado — castillo de proa",d:"Lavado completo del castillo de proa: cubierta proa, guías de ancla, molinete (exterior), bitas de proa. Salitre, sal y grasa.",cat:"HK"},
    {id:"17b2",t:"Control óxido — castillo de proa",d:"Detectar y tratar óxido en castillo de proa: bordes, estructuras, guías. Picar, grata, protector.",cat:"OX"},
    {id:"17b3",t:"Revisión escala real y escalerillas",d:"Inspeccionar peldaños, líneas de vida y grilletes de sujeción. Lubricar zonas oxidadas.",cat:"INS"},
  ]},
{note:"Jueves: cubierta, inspección completa de grúas y control de óxido.",
  alpha:[
    {id:"18a1",t:"Revisión completa grúas (2ª del embarco)",d:"Inspección estructural detallada: cables/eslingas, ganchos, seguros y mandos de las 4 grúas. Prueba de mandos con autorización. Registrar en bitácora.",cat:"MANT"},
    {id:"18a2",t:"Control óxido — estructuras grúas",d:"Tratamiento de óxido en estructuras de las 4 grúas: detectar, picar, grata, limpiar y aplicar protector temporal.",cat:"OX"},
    {id:"18a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"18b1",t:"Control óxido — piping y soportes cubierta",d:"Inspección de todo el piping expuesto y sus soportes. Tratar óxido activo. Fotografiar para registro de verano.",cat:"OX"},
    {id:"18b2",t:"Revisión mangueras de traspaso wellboat",d:"Inspeccionar estado de mangueras, acoples y abrazaderas. Estiba correcta.",cat:"INS"},
    {id:"18b3",t:"Lubricación cabrestante (2ª embarco)",d:"Limpieza y lubricación completa del cabrestante.",cat:"MANT"},
  ]},
{note:"Viernes: rutinas SOLAS/FIFI semanales (3ª semana) — Ignacio Ulloa.",
  alpha:[
    {id:"19a1",t:"LSA semanal — chalecos, trajes y señalética",d:"Conteo chalecos, revisión luces/silbatos, revisión trajes, verificar señalética actualizada. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"19a2",t:"Control óxido — molinete y sistema de fondeo",d:"Detectar óxido en molinete, cadena de ancla y guías. Tratar con grata y protector.",cat:"OX"},
    {id:"19a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"19b1",t:"FIFI semanal — estaciones CI, extintores, EEBD",d:"Revisión semanal completa. Registrar en planilla. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"19b2",t:"FIFI semanal — alarma general y altavoces",d:"Prueba semanal de alarma general y comunicación altavoces. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"19b3",t:"Aseo baños y vestíbulo (rutina)",d:"Limpieza completa. Reposición de insumos.",cat:"HK"},
  ]},
{note:"Sábado: pañol de cubierta — clasificación, inventario y etiquetado final.",
  alpha:[
    {id:"20a1",t:"Pañol de cubierta — clasificación y orden",d:"Clasificar todo: herramientas por tipo y función. Separar lo que va a dar de baja. Orden lógico.",cat:"HK"},
    {id:"20a2",t:"Pañol de cubierta — inventario y etiquetado",d:"Inventario completo. Etiquetar estantes y herramientas. Registrar herramientas en mal estado.",cat:"INV"},
    {id:"20a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"20b1",t:"Pañol de útiles de aseo — vaciado y limpieza",d:"Sacar todo, limpiar el pañol por dentro. Clasificar y re-estibar.",cat:"HK"},
    {id:"20b2",t:"Pañol de útiles de aseo — inventario",d:"Inventario completo. Reportar stock necesario para el resto del embarco.",cat:"INV"},
    {id:"20b3",t:"LSA semanal — balsas y señalética",d:"Revisión lanzamiento hidrostático, trinca, accesos y señalética. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
  ]},
{note:"Domingo: trabajo liviano. Inspecciones mensuales SOLAS (2ª parte) — Ignacio Ulloa.",
  alpha:[
    {id:"21a1",t:"FIFI mensual — equipos respiratorios autónomos",d:"Revisión de presión de cilindros, estado de máscaras, limpieza y verificación de inventario completo. Registrar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"21a2",t:"FIFI mensual — sistemas fijos (inspección visual)",d:"Inspección visual externa de cilindros CO2/espuma/agua: asegurados, señalética visible. Sin operar. (Coord. Ignacio Ulloa)",cat:"FIFI"},
    {id:"21a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"21b1",t:"LSA mensual — pirotecnia y aros salvavidas",d:"Verificación de fechas de expiración de pirotecnia. Inventario. Revisión de aros salvavidas: luces, líneas, señales de humo y soportes. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"21b2",t:"LSA mensual — aparejos de arriada",d:"Prueba operacional parcial de aparejos de arriada. Lubricación. Revisión de frenos visibles. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"21b3",t:"Aseo baños y vestíbulo (rutina)",d:"Limpieza de rutina. Reposición de insumos.",cat:"HK"},
  ]},
{note:"Lunes semana final. Aseo interior profundo. Preparativos para el relevo.",
  alpha:[
    {id:"22a1",t:"Gran aseo pañol de pinturas/SOPEP (entrega)",d:"Limpiar, re-organizar y verificar completitud del SOPEP. Cerrar bien todos los envases. Inventario final.",cat:"HK"},
    {id:"22a2",t:"Aseo profundo puente (entrega)",d:"Limpieza profunda: consolas, paneles, vidrios, cielos, cajones. Dejar en condiciones de entrega.",cat:"HK"},
    {id:"22a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"22b1",t:"Gran lavado cubierta de trabajo (entrega)",d:"Lavado completo con manguera. Foco en zonas alrededor de grúas, escotillas y maquinaria.",cat:"HK"},
    {id:"22b2",t:"Aseo profundo baños y vestíbulo (entrega)",d:"Limpieza profunda completa. Desinfección. Inox al brillo. Reposición total de insumos para el relevo.",cat:"HK"},
    {id:"22b3",t:"Control óxido — recorrida final cubierta",d:"Última recorrida de detección de óxido activo. Tratar pendientes. Fotografiar todo para informe de verano.",cat:"OX"},
  ]},
{note:"Antepenúltimo día. Inventarios finales y recorrida de verificación general.",
  alpha:[
    {id:"23a1",t:"Recorrida de verificación general",d:"José Montecinos recorre todo el buque verificando que no quede nada pendiente. Hacer lista de puntos a resolver en los últimos 2 días.",cat:"INS"},
    {id:"23a2",t:"Inventario final EPP (entrega)",d:"Inventario completo de EPP. Registrar lo que necesita reposición para la tripulación entrante. (Coord. Ignacio Ulloa)",cat:"LSA"},
    {id:"23a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria.",cat:"HK"},
  ],
  beta:[
    {id:"23b1",t:"Aseo sala RSW (entrega final)",d:"Limpieza a fondo. Dejar en condiciones impecables para el relevo.",cat:"HK"},
    {id:"23b2",t:"Inventario consolidado — todos los pañoles",d:"Camilo Canales consolida inventarios de pañoles del equipo. Preparar para entrega.",cat:"INV"},
    {id:"23b3",t:"FIFI semanal — revisión completa",d:"Cuarta y última ronda semanal del embarco. Registrar en planilla. (Coord. Ignacio Ulloa)",cat:"FIFI"},
  ]},
{note:"Penúltimo día. Resolver todos los pendientes. Cubierta en condiciones de entrega.",
  alpha:[
    {id:"24a1",t:"Resolver pendientes — lista de verificación",d:"Abordar todos los puntos pendientes de la recorrida. Priorizar los que afectan seguridad y operación.",cat:"INS"},
    {id:"24a2",t:"Preparar documentación completa para entrega",d:"Organizar inventarios, bitácoras de equipos, registros de mantenimiento, formación y planillas SOLAS/FIFI para traspaso.",cat:"INS"},
    {id:"24a3",t:"Aseo cubierta de trabajo",d:"Rutina diaria. Dejar impecable.",cat:"HK"},
  ],
  beta:[
    {id:"24b1",t:"Control óxido — informe final para verano",d:"Compilar todas las fotografías y registros de óxido del embarco. Preparar informe de zonas identificadas para pintado en verano.",cat:"OX"},
    {id:"24b2",t:"Aseo cubierta popa y castillo proa (entrega)",d:"Lavado completo de extremos del buque. Dejar en condiciones impecables.",cat:"HK"},
    {id:"24b3",t:"LSA semanal final",d:"Última ronda semanal LSA del embarco: chalecos, trajes, balsas, señalética. Registrar. (Coord. Ignacio Ulloa)",cat:"LSA"},
  ]},
{note:"Último día de embarco. Entrega de guardia impecable para el relevo.",
  alpha:[
    {id:"25a1",t:"Entrega formal de pañoles — José Montecinos",d:"Recorrida y firma de inventarios de entrega: pañol de proa, pañol de cubierta y pinturas/SOPEP. Entregar informe completo al 1° Oficial.",cat:"INV"},
    {id:"25a2",t:"Aseo final cubierta de trabajo",d:"Última limpieza del embarco. Dejar cubierta impecable.",cat:"HK"},
    {id:"25a3",t:"Entrega de documentación al 1° Oficial",d:"Inventarios, bitácoras, planillas SOLAS/FIFI, informe de óxido para verano, registros de formación y novedades del embarco.",cat:"INS"},
  ],
  beta:[
    {id:"25b1",t:"Entrega pañol de aseo — Camilo Canales",d:"Inventario final y entrega formal del pañol de útiles de aseo. Firmar planilla.",cat:"INV"},
    {id:"25b2",t:"Aseo final sala RSW, baños y vestíbulo",d:"Última limpieza de todas las zonas asignadas al equipo. Dejar en condiciones de entrega.",cat:"HK"},
    {id:"25b3",t:"Apoyo en entrega de guardia",d:"Asistir a José Montecinos en la presentación del buque a la tripulación entrante.",cat:"INS"},
  ]},
];

const TAREAS_CARGA = {
  alpha:[
    {id:"ca1",t:"Operación carga / descarga",d:"José Montecinos lidera todas las maniobras de amarre, desamarre y posicionamiento. Toda la tripulación convocada. Seguir instrucciones del 1° Oficial.",cat:"CARGA"},
    {id:"ca2",t:"Post-operación: aseo cubierta wellboat",d:"Al finalizar: lavar con manguera la cubierta de trabajo, limpiar escotillas wellboat, retirar residuos orgánicos. Estibar mangueras de traspaso.",cat:"HK"},
    {id:"ca3",t:"⚓ TRINCA Y ALISTAMIENTO PARA LA MAR — José Montecinos",d:"Contramaestre supervisa y verifica: todo el equipo de cubierta trincado, escotillas aseguradas, mangueras estibadas y amarradas, cabos en su lugar, guardas y defensas a bordo. Buque listo para cruce del Golfo Corcovado. Reportar al 1° Oficial.",cat:"INS"},
  ],
  beta:[
    {id:"cb1",t:"Apoyo maniobras zona popa",d:"Camilo Canales y equipo: manejo de cabos, mangueras y coordinación con terminal. Mantener zona segura y despejada.",cat:"CARGA"},
    {id:"cb2",t:"Post-operación: lavado cubierta popa",d:"Lavado completo de zona popa y mangueras usadas. Dejar en condiciones.",cat:"HK"},
    {id:"cb3",t:"Verificación zona popa para la mar",d:"Confirmar que zona popa está limpia, trincada y sin elementos sueltos antes del zarpe. Reportar al contramaestre.",cat:"INS"},
  ],
};

const LSA_SEMANAL = [
  "Bote de rescate — inspección visual exterior","Bote de rescate — revisión amarras y painter",
  "Bote de rescate — revisión drenajes","Bote de rescate — revisión baterías (visual)",
  "Bote de rescate — revisión combustible (visual)","Bote de rescate — verificación inventario",
  "Balsas salvavidas — revisión lanzamiento hidrostático","Balsas salvavidas — verificación trinca y accesos",
  "Balsas salvavidas — revisión señalética","Chalecos salvavidas — conteo aleatorio",
  "Chalecos salvavidas — revisión luces de inmersión","Chalecos salvavidas — revisión silbatos",
  "Chalecos salvavidas — orden en lockers","Trajes de inmersión — revisión visual y cremallera",
  "Trajes de inmersión — orden de almacenamiento",
];
const FIFI_SEMANAL = [
  "Estaciones CI — revisión mangueras y enrollado","Estaciones CI — revisión boquillas/pitones",
  "Estaciones CI — limpieza de gabinetes","Extintores portátiles — presión visual (manómetro)",
  "Extintores portátiles — revisión sello de seguridad","Extintores portátiles — accesibilidad y limpieza exterior",
  "EEBD — presión visual y accesibilidad","EEBD — limpieza de gabinetes",
  "Puertas CI — prueba de cierre, rieles y sellos","Luminarias de emergencia — prueba visual",
  "Alarma general — prueba semanal","Altavoces — prueba de comunicación",
];

const estilos = {
  app:{ background:"#080f1a", minHeight:"100vh", fontFamily:"'IBM Plex Mono',monospace", color:"#c8daf0", fontSize:"15px", WebkitTextSizeAdjust:"100%" },
  btn:(on,col)=>({ fontFamily:"'IBM Plex Mono',monospace", fontSize:".75rem", cursor:"pointer", border:`1px solid ${on?col:"#1a3050"}`, borderRadius:3, padding:"6px 14px", letterSpacing:1, textTransform:"uppercase", background:on?col+"20":"transparent", color:on?col:"#4a6580", transition:"all .15s" }),
};

function Tag({cat}){
  const c=CATS[cat]; if(!c) return null;
  return <span style={{display:"inline-block",fontSize:".65rem",letterSpacing:1,textTransform:"uppercase",padding:"2px 8px",borderRadius:2,background:c.bg,color:c.color,border:`1px solid ${c.border}`,marginTop:3}}>{c.label}</span>;
}

function ModalClave({titulo,onConfirm,onCancel}){
  const [v,setV]=useState(""); const [err,setErr]=useState(false);
  const ok=()=>{ if(v.trim()===String(CLAVE)){onConfirm();}else{setErr(true);setV("");} };
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#0d1a2e",border:`1px solid ${C.accent}`,borderRadius:6,padding:24,width:"100%",maxWidth:380}}>
        <div style={{fontSize:".65rem",color:C.accent,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>🔒 Acción protegida</div>
        <div style={{fontSize:".88rem",color:C.white,marginBottom:16}}>{titulo}</div>
        <input type="password" value={v} onChange={e=>{setV(e.target.value);setErr(false);}} placeholder="Ingrese la clave..."
          style={{width:"100%",background:"#080f1a",border:`1px solid ${err?C.red:C.border}`,borderRadius:4,color:C.text,fontFamily:"'IBM Plex Mono',monospace",fontSize:"1rem",padding:"13px 14px",outline:"none",minHeight:48}}
          onKeyDown={e=>e.key==="Enter"&&ok()} autoFocus/>
        {err&&<div style={{fontSize:".72rem",color:C.red,marginTop:5}}>Clave incorrecta</div>}
        <div style={{display:"flex",gap:10,marginTop:16,justifyContent:"flex-end"}}>
          <button style={{...estilos.btn(false,C.muted),padding:"12px 20px",fontSize:".8rem",minHeight:44}} onClick={onCancel}>Cancelar</button>
          <button style={{...estilos.btn(true,C.accent),padding:"12px 20px",fontSize:".8rem",minHeight:44,fontWeight:600}} onClick={ok}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}

function ModalNota({task,notas,diaKey,onGuardar,onEliminar,onCerrar}){
  const hist=notas[`${diaKey}_${task.id}`]||[];
  const [nueva,setNueva]=useState("");
  const [autor,setAutor]=useState("");
  const [pedirClave,setPedirClave]=useState(null);
  const puedeGuardar=nueva.trim()&&autor;
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onClick={e=>e.target===e.currentTarget&&onCerrar()}>
      <div style={{background:"#0d1a2e",border:`1px solid ${C.accent}`,borderRadius:6,padding:24,width:"100%",maxWidth:580,maxHeight:"85vh",overflowY:"auto"}}>
        <div style={{fontSize:".65rem",color:C.accent,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Notas / Observaciones</div>
        <div style={{fontSize:".9rem",color:C.white,marginBottom:16,fontWeight:600}}>{task.t}</div>

        {hist.length>0&&(
          <div style={{marginBottom:16}}>
            <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Registro ({hist.length}):</div>
            {hist.map((n,i)=>(
              <div key={i} style={{background:"rgba(14,165,233,.06)",border:"1px solid rgba(14,165,233,.2)",borderRadius:4,padding:"10px 12px",marginBottom:8}}>
                <div style={{fontSize:".7rem",color:C.amber,marginBottom:4,fontWeight:600}}>{n.autor} — {n.fecha}</div>
                <div style={{fontSize:".82rem",color:C.text,lineHeight:1.6}}>{n.texto}</div>
                <button onClick={()=>setPedirClave({idx:i,diaKey})} style={{...estilos.btn(false,C.red),padding:"2px 9px",fontSize:".62rem",marginTop:6}}>🗑 Eliminar (requiere clave)</button>
              </div>
            ))}
          </div>
        )}

        <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>¿Quién escribe esta nota?</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:14}}>
          {TRIPULANTES.map(t=>(
            <button key={t.id} onClick={()=>setAutor(`${t.nombre} — ${t.cargo}`)}
              style={{...estilos.btn(autor===`${t.nombre} — ${t.cargo}`,C.accent),padding:"8px 10px",fontSize:".72rem",textAlign:"left",textTransform:"none",letterSpacing:0}}>
              <div style={{fontWeight:600,color:autor===`${t.nombre} — ${t.cargo}`?C.accent:C.white}}>{t.nombre}</div>
              <div style={{fontSize:".62rem",color:C.muted,marginTop:1}}>{t.cargo}</div>
            </button>
          ))}
        </div>

        <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Nota / Observación:</div>
        <textarea value={nueva} onChange={e=>setNueva(e.target.value)} placeholder="Escriba su observación, avance o novedad aquí..."
          style={{width:"100%",minHeight:120,background:"#080f1a",border:`1px solid ${autor?C.border:"rgba(239,68,68,.4)"}`,borderRadius:4,color:C.text,fontFamily:"'IBM Plex Mono',monospace",fontSize:".82rem",padding:"11px 13px",resize:"vertical",outline:"none",lineHeight:1.6}}/>
        {!autor&&nueva.trim()&&<div style={{fontSize:".7rem",color:C.red,marginTop:4}}>Debe seleccionar quién escribe antes de guardar.</div>}

        <div style={{display:"flex",gap:8,marginTop:12,justifyContent:"flex-end"}}>
          <button style={estilos.btn(false,C.muted)} onClick={onCerrar}>Cerrar</button>
          <button style={estilos.btn(puedeGuardar,C.accent)} onClick={()=>{if(puedeGuardar){onGuardar(task.id,nueva,autor,diaKey);setNueva("");setAutor("");}}} disabled={!puedeGuardar}>Guardar nota</button>
        </div>
      </div>
      {pedirClave!==null&&<ModalClave titulo="¿Eliminar esta nota?" onConfirm={()=>{onEliminar(task.id,pedirClave.idx,pedirClave.diaKey);setPedirClave(null);}} onCancel={()=>setPedirClave(null)}/>}
    </div>
  );
}

function Tarea({task,notas,completados,diaKey,onAbrir,onCompletar,onDesmarcar}){
  const hist=notas[`${diaKey}_${task.id}`]||[];
  const comp=completados[`${diaKey}_${task.id}`];
  const isComp=!!comp;
  return(
    <li style={{display:"flex",gap:10,alignItems:"flex-start",padding:"12px 0",borderBottom:`1px solid ${C.borderB}`,opacity:isComp?0.7:1}}>
      <div style={{paddingTop:3,flexShrink:0}}>
        {isComp
          ? <div style={{width:18,height:18,borderRadius:"50%",background:C.green,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:C.bg,fontWeight:700}}>✓</div>
          : <div style={{width:18,height:18,borderRadius:"50%",border:`1px solid ${C.muted}`,cursor:"pointer"}} onClick={()=>onCompletar(task)}/>
        }
      </div>
      <div style={{flex:1}}>
        <div style={{fontSize:".88rem",fontWeight:600,color:isComp?C.dim:C.white,lineHeight:1.4,textDecoration:isComp?"line-through":"none"}}>{task.t}</div>
        {!isComp&&<div style={{fontSize:".8rem",color:C.dim,marginTop:3,lineHeight:1.5}}>{task.d}</div>}
        {isComp&&(
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2,flexWrap:"wrap"}}>
            <div style={{fontSize:".68rem",color:C.green}}>✓ Realizado por {comp.autor} — {comp.fecha}</div>
            <button onClick={()=>onDesmarcar({...task,_diaKey:diaKey})} style={{...estilos.btn(false,C.red),padding:"2px 8px",fontSize:".6rem"}}>Desmarcar</button>
          </div>
        )}
        {!isComp&&(
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6,flexWrap:"wrap"}}>
            <Tag cat={task.cat}/>
            <button onClick={()=>onAbrir(task)} style={{...estilos.btn(hist.length>0,C.accent),padding:"3px 10px",fontSize:".67rem"}}>
              {hist.length>0?`📝 ${hist.length} nota${hist.length>1?"s":""}`:"+ Nota"}
            </button>
            <button onClick={()=>onCompletar(task)} style={{...estilos.btn(false,C.green),padding:"3px 10px",fontSize:".67rem"}}>
              ✓ Marcar realizado
            </button>
          </div>
        )}
        {hist.length>0&&!isComp&&(
          <div style={{marginTop:8,background:"rgba(14,165,233,.05)",border:"1px solid rgba(14,165,233,.15)",borderRadius:3,padding:"8px 11px"}}>
            <div style={{fontSize:".65rem",color:C.amber,marginBottom:3}}>{hist[hist.length-1].autor} — {hist[hist.length-1].fecha}</div>
            <div style={{fontSize:".78rem",color:C.dim,fontStyle:"italic",lineHeight:1.5}}>{hist[hist.length-1].texto}</div>
          </div>
        )}
      </div>
    </li>
  );
}

function CardEquipo({titulo,miembros,guardia,color,tareas,notas,completados,diaKey,onAbrir,onCompletar,onDesmarcar}){
  return(
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden"}}>
      <div style={{padding:"11px 16px",borderBottom:`2px solid ${color}`,background:`${color}10`}}>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.2rem",letterSpacing:2,color}}>{titulo}</div>
        <div style={{fontSize:".72rem",color:C.muted,letterSpacing:1,textTransform:"uppercase",marginTop:2}}>{miembros}</div>
        <div style={{fontSize:".67rem",color:C.dim,marginTop:1}}>{guardia}</div>
      </div>
      <ul style={{listStyle:"none",padding:"0 16px",margin:0}}>
        {tareas.map(t=><Tarea key={t.id} task={t} notas={notas} completados={completados} diaKey={diaKey} onAbrir={onAbrir} onCompletar={onCompletar} onDesmarcar={onDesmarcar}/>)}
      </ul>
    </div>
  );
}

function BarraGuardias({diaNum}){
  const g=guardiasDia(diaNum);
  const activa=guardiaActual();
  return(
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:18}}>
      {[g.a,g.b,g.c].map((t,i)=>{
        const isA=t.t===activa;
        return(
          <div key={i} style={{background:isA?"rgba(14,165,233,.08)":C.surface,border:`1px solid ${isA?C.accent:C.border}`,borderRadius:5,padding:"9px 13px"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.05rem",color:C.amber,letterSpacing:1}}>{t.t}</div>
            <div style={{fontSize:".75rem",color:C.white,marginTop:2}}>{t.eq}</div>
            <div style={{fontSize:".65rem",color:C.muted,marginTop:1}}>José Montecinos — supervisión permanente</div>
            {isA&&<div style={{fontSize:".6rem",color:C.accent,textTransform:"uppercase",letterSpacing:1.5,marginTop:4}}>▶ Activa ahora</div>}
          </div>
        );
      })}
    </div>
  );
}

function PanelCarga({diaNum,operaciones,todoCargaH,onAgregarOp,onCerrarOp,fechaDiaStr}){
  const [tipo,setTipo]=useState("Carga");
  const [fechaIni,setFechaIni]=useState("");
  const [horaIni,setHoraIni]=useState("");
  const [fechaFin,setFechaFin]=useState("");
  const [horaFin,setHoraFin]=useState("");
  const [horaFinCruce,setHoraFinCruce]=useState("");

  const opsPropio=(Array.isArray(operaciones)?operaciones:(operaciones&&operaciones.horaIni?[operaciones]:[])).slice().sort((a,b)=>(a.horaIni||"").localeCompare(b.horaIni||""));

  // Operación en curso del día anterior
  const _prev=todoCargaH[diaNum-1];
  const prevOps=Array.isArray(_prev)?_prev:(_prev&&_prev.horaIni?[_prev]:[]);
  const opEnCursoPrev=prevOps.find(op=>!op.horaFin);

  const registrar=()=>{
    if(!horaIni) return;
    onAgregarOp({tipo, fechaIni:fechaIni||fechaDiaStr, horaIni, fechaFin:fechaFin||"", horaFin:horaFin||""});
    setHoraIni(""); setHoraFin(""); setFechaIni(""); setFechaFin("");
  };

  const cerrarCruce=()=>{
    if(!horaFinCruce) return;
    onCerrarOp(opEnCursoPrev, horaFinCruce, fechaDiaStr);
    setHoraFinCruce("");
  };

  const allOps=[
    ...(opEnCursoPrev?[{...opEnCursoPrev,_desdeDiaAnterior:true}]:[]),
    ...opsPropio
  ];

  const inputStyle={background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.text,fontFamily:"'IBM Plex Mono',monospace",fontSize:".82rem",padding:"7px 8px",outline:"none"};

  return(
    <div style={{background:"rgba(239,68,68,.07)",border:"1px solid rgba(239,68,68,.35)",borderRadius:6,padding:"14px 18px",marginBottom:18}}>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.3rem",letterSpacing:2,color:C.red,marginBottom:10}}>⚡ Operaciones</div>

      {allOps.length>0&&(
        <div style={{marginBottom:14}}>
          {allOps.map((op,i)=>(
            <div key={i} style={{background:op._desdeDiaAnterior?"rgba(245,158,11,.1)":"rgba(239,68,68,.08)",border:`1px solid ${op._desdeDiaAnterior?"rgba(245,158,11,.3)":"rgba(239,68,68,.2)"}`,borderRadius:4,padding:"10px 12px",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1rem",color:op._desdeDiaAnterior?C.amber:C.red,letterSpacing:1}}>{op.tipo}</span>
                {op._desdeDiaAnterior&&<span style={{fontSize:".6rem",color:C.amber,background:"rgba(245,158,11,.15)",padding:"1px 6px",borderRadius:2}}>DESDE DÍA ANTERIOR</span>}
                <span style={{fontSize:".78rem",color:C.white}}>
                  Inicio: {op.fechaIni?op.fechaIni+" ":""}{op.horaIni}
                  {op.horaFin
                    ? <span style={{color:C.muted}}> → Fin: {op.fechaFin&&op.fechaFin!==op.fechaIni?op.fechaFin+" ":""}{op.horaFin}</span>
                    : <span style={{fontSize:".6rem",color:C.amber,marginLeft:6,background:"rgba(245,158,11,.15)",padding:"1px 6px",borderRadius:2}}>EN CURSO</span>
                  }
                </span>
              </div>
              {op._desdeDiaAnterior&&!op.horaFin&&(
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginTop:8,paddingTop:8,borderTop:"1px solid rgba(245,158,11,.2)"}}>
                  <div style={{fontSize:".65rem",color:C.amber,letterSpacing:1,textTransform:"uppercase"}}>Registrar término:</div>
                  <input type="time" value={horaFinCruce} onChange={e=>setHoraFinCruce(e.target.value)} style={{...inputStyle,border:`1px solid ${C.amber}`}}/>
                  <button style={{...estilos.btn(!!horaFinCruce,C.amber),padding:"6px 14px",minHeight:36}} onClick={cerrarCruce} disabled={!horaFinCruce}>Cerrar operación</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Nueva operación:</div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:4,alignItems:"flex-end"}}>
        <div>
          <div style={{fontSize:".6rem",color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Tipo</div>
          <div style={{display:"flex",gap:6}}>
            {["Carga","Descarga"].map(t=>(
              <button key={t} onClick={()=>setTipo(t)} style={{...estilos.btn(tipo===t,C.red),padding:"6px 12px",fontSize:".72rem"}}>{t}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{fontSize:".6rem",color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Fecha inicio</div>
          <input type="date" value={fechaIni} onChange={e=>setFechaIni(e.target.value)} style={inputStyle}/>
        </div>
        <div>
          <div style={{fontSize:".6rem",color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Hora inicio</div>
          <input type="time" value={horaIni} onChange={e=>setHoraIni(e.target.value)} style={inputStyle}/>
        </div>
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:12,alignItems:"flex-end"}}>
        <div>
          <div style={{fontSize:".6rem",color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Fecha fin (si termina hoy)</div>
          <input type="date" value={fechaFin} onChange={e=>setFechaFin(e.target.value)} style={inputStyle}/>
        </div>
        <div>
          <div style={{fontSize:".6rem",color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Hora fin (opcional)</div>
          <input type="time" value={horaFin} onChange={e=>setHoraFin(e.target.value)} style={inputStyle}/>
        </div>
        <button style={{...estilos.btn(!!horaIni,C.red),padding:"8px 16px",minHeight:38,fontSize:".75rem"}} onClick={registrar} disabled={!horaIni}>+ Registrar</button>
      </div>

      <div style={{fontSize:".72rem",color:C.dim,lineHeight:1.5,borderTop:`1px solid rgba(239,68,68,.2)`,paddingTop:10}}>
        Si la operación cruza la medianoche, deja la hora de fin en blanco — quedará EN CURSO y aparecerá automáticamente en el día siguiente para que ingreses el término.
        <br/><strong style={{color:C.amber}}>Post-operación: José Montecinos verifica trinca y alistamiento para la mar (Golfo Corcovado).</strong>
      </div>
    </div>
  );
}

function SeccionSolas({solas,setSolas,semana}){
  const [pedirClave,setPedirClave]=useState(null);
  const intentar=(tipo,idx)=>setPedirClave({tipo,idx});
  const confirmar=()=>{
    const {tipo,idx}=pedirClave;
    const key=`${tipo}_${semana}_${idx}`;
    setSolas(prev=>({...prev,[key]:!prev[key]}));
    setPedirClave(null);
  };
  const Lista=({items,tipo,titulo,color})=>(
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:5,marginBottom:16,overflow:"hidden"}}>
      <div style={{padding:"9px 14px",borderBottom:`2px solid ${color}`,background:`${color}12`}}>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.02rem",letterSpacing:2,color}}>{titulo} — Semana {semana}</div>
        <div style={{fontSize:".67rem",color:C.muted,marginTop:2}}>Coordinador: Ignacio Ulloa — 2° Piloto</div>
      </div>
      <ul style={{listStyle:"none",padding:"0 14px",margin:0}}>
        {items.map((item,idx)=>{
          const key=`${tipo}_${semana}_${idx}`;
          const checked=!!solas[key];
          return(
            <li key={idx} onClick={()=>intentar(tipo,idx)} style={{display:"flex",gap:10,alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.borderB}`,cursor:"pointer"}}>
              <div style={{width:18,height:18,borderRadius:2,border:`1px solid ${checked?color:C.muted}`,background:checked?color:"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:checked?C.bg:"transparent",fontWeight:700}}>✓</div>
              <span style={{fontSize:".8rem",color:checked?C.dim:C.text,textDecoration:checked?"line-through":"none"}}>{item}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
  return(
    <div>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.4rem",letterSpacing:2,marginBottom:8,borderBottom:`1px solid ${C.border}`,paddingBottom:8}}>Rutinas SOLAS / LSA / FIFI</div>
      <div style={{fontSize:".75rem",color:C.amber,marginBottom:16,background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.2)",borderRadius:4,padding:"9px 13px"}}>
        🔒 Los checklists están protegidos con clave para evitar pérdida de información. Solo el 1° Oficial puede marcar o desmarcar ítems.
      </div>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        {[1,2,3,4].map(w=>(
          <button key={w} onClick={()=>setSolas(s=>s)} style={estilos.btn(semana===w,C.amber)}>Semana {w}</button>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <Lista items={LSA_SEMANAL} tipo="lsa" titulo="LSA Semanal" color={C.amber}/>
        <Lista items={FIFI_SEMANAL} tipo="fifi" titulo="FIFI / CI Semanal" color={C.red}/>
      </div>
      {pedirClave&&<ModalClave titulo="Marcar/desmarcar ítem SOLAS — requiere clave del 1° Oficial" onConfirm={confirmar} onCancel={()=>setPedirClave(null)}/>}
    </div>
  );
}

// ─── ZAFARRANCHOS ─────────────────────────────────────────────────────────────

const TRIPULANTES_OPERATIVOS = [
  { id:"camilo", nombre:"Camilo Canales",   cargo:"Marino 1"      },
  { id:"david",  nombre:"David Cancino",    cargo:"Marino 2"      },
  { id:"jose",   nombre:"José Montecinos",  cargo:"Contramaestre" },
];

const TRIPULANTES = [
  { id:"ruben",    nombre:"Rubén Victoriano",  cargo:"Capitán"          },
  { id:"guillermo",nombre:"Guillermo Pérez",    cargo:"Primer Piloto"    },
  { id:"ignacio",  nombre:"Ignacio Ulloa",      cargo:"Segundo Piloto"   },
  { id:"jose",     nombre:"José Montecinos",    cargo:"Contramaestre"    },
  { id:"camilo",   nombre:"Camilo Canales",     cargo:"Marino 1"         },
  { id:"david",    nombre:"David Cancino",      cargo:"Marino 2"         },
];

const ZAFARRANCHOS = [
  { id:"zaf1", num:1, nombre:"Zafarrancho de Incendio", ref:"SOLAS Cap.III/Reg.19 — Obligatorio si hubiese cambio de tripulación sobre un 25%, hasta 24 hrs posteriores al zarpe.", freq:"Mensual", color:"#ef4444" },
  { id:"zaf2", num:2, nombre:"Zafarrancho de Abandono", ref:"SOLAS Cap.III/Reg.19 — Obligatorio si hubiese cambio de tripulación sobre un 25%, hasta 24 hrs posteriores al zarpe.", freq:"Mensual", color:"#ef4444" },
  { id:"zaf3", num:3, nombre:"Falla PLC", ref:"SGI Cap V — Hasta 72 hrs posteriores al zarpe.", freq:"Mensual", color:"#f59e0b" },
  { id:"zaf4", num:4, nombre:"Entrada y Salvamento en Espacio Cerrado", ref:"SOLAS Cap.III, regla 19.3.6 MSC.1/circ1601", freq:"Cada 2 meses", color:"#f59e0b" },
  { id:"zaf5", num:5, nombre:"Gobierno de Emergencia", ref:"SOLAS Cap.II-1 Reg 29", freq:"Cada 3 meses", color:"#8b5cf6" },
  { id:"zaf6", num:6, nombre:"Persona al Agua y Rescate de Personas desde el Agua", ref:"ISM sección VIII", freq:"Cada 3 meses", color:"#8b5cf6" },
  { id:"zaf7", num:7, nombre:"Emergencia Médica (Ejercicio e Inducción)", ref:"ISM - SMS", freq:"Cada 3 meses", color:"#8b5cf6" },
  { id:"zaf8", num:8, nombre:"SOPEP / Contaminación (Hidrocarburos / S.N.L.)", ref:"Marpol 73/78 Anexo 1 Reg 37", freq:"Cada 3 meses", color:"#8b5cf6" },
  { id:"zaf9", num:9, nombre:"Black Out (Ejercicio e Inducción)", ref:"Cod ISM sección VIII", freq:"Cada 6 meses", color:"#10b981" },
  // Fuga de amoníaco excluida — sin planta RSW a bordo
];

const FREQ_COLOR = { "Mensual":"#ef4444", "Cada 2 meses":"#f59e0b", "Cada 3 meses":"#8b5cf6", "Cada 6 meses":"#10b981" };


// Get all operations for a day including cross-day ones from adjacent days
function getOpsForDay(diaNum, cargaH) {
  const ops = Array.isArray(cargaH[diaNum]) ? [...cargaH[diaNum]] :
    (cargaH[diaNum]&&cargaH[diaNum].inicio ? [cargaH[diaNum]] : []);
  // Check previous day for ops that end on this day
  const inicio = new Date(2026, 4, 17);
  const thisFecha = new Date(inicio);
  thisFecha.setDate(thisFecha.getDate() + diaNum - 1);
  const thisFechaStr = thisFecha.toISOString().slice(0,10);
  
  const prevOps = Array.isArray(cargaH[diaNum-1]) ? cargaH[diaNum-1] : [];
  prevOps.forEach(op => {
    if(op.fechaFin && op.fechaFin === thisFechaStr && op.horaFin) {
      ops.push({...op, _crossDay:true, _fromDay:diaNum-1});
    }
  });
  return ops.sort((a,b)=>{
    const ta=a.fechaIni?new Date(a.fechaIni+" "+(a.horaIni||"00:00")):0;
    const tb=b.fechaIni?new Date(b.fechaIni+" "+(b.horaIni||"00:00")):0;
    return ta-tb;
  });
}

// ─── PAÑOLES COMPLETOS ────────────────────────────────────────────────────────

// Mapeo de tareas diarias LSA/FIFI → ítems del checklist semanal
const LSA_TASK_MAP = {
  "5a1": [0,1,2,3,4,5],   // chalecos → ítems 0-5 LSA
  "5a2": [13,14],          // trajes inmersión → ítems 13-14 LSA
  "6b2": [6,7,8],          // balsas → ítems 6-8 LSA
  "7b1": [10,11],          // alarma/altavoces → FIFI 10-11
  "7b2": [8,9],            // puertas CI/luminarias → FIFI 8-9
  "5b1": [0,1,2],          // estaciones CI → FIFI 0-2
  "5b2": [3,4,5],          // extintores → FIFI 3-5
  "6b1": [6,7],            // EEBD → FIFI 6-7
  "12a1":[0,1,13,14],      // LSA semana 2
  "12b1":[0,1,2,3,4,5,6,7],// FIFI semana 2
  "12b2":[8,9,10,11],
  "19a1":[0,1,13,14],      // LSA semana 3
  "19b1":[0,1,2,3,4,5,6,7],
  "19b2":[8,9,10,11],
};

const PANOLES_LISTA = [
  {n:"Techo Puente de Gobierno",          r:"Equipo Beta",    f:"Semanal",     d:"Limpieza exterior de superficies, antenas y estructuras accesibles. Control de óxido en soportes y herrajes. Revisar estado de antideslizantes."},
  {n:"Puente de Gobierno",                r:"Ignacio Ulloa",  f:"Cada 2 días", d:"Consolas, paneles, vidrios, acrílicos, cielos, sillas, cajones, alerones. Inox al brillo. Revisar luminarias. Mantener orden de documentación."},
  {n:"Cubierta Castillo",                 r:"Equipo Alpha",   f:"Diaria",      d:"Barrer, lampazo, retirar residuos. Revisar antideslizantes. Control de óxido en handrails y estructuras."},
  {n:"Cubierta Bote Auxiliar",            r:"José Montecinos",f:"Semanal",     d:"Aseo completo de cubierta. Revisión del bote auxiliar: casco, motor, EPP, carburante, aparejos de arriada. Registrar en bitácora."},
  {n:"Cubierta Shelter",                  r:"Equipo Beta",    f:"Cada 2 días", d:"Barrer y lampazo. Limpiar superficies y estructuras del shelter. Control de óxido en herrajes y soportes."},
  {n:"Cubierta Principal",                r:"Todos",          f:"Diaria",      d:"Barrer, lampazo, retirar residuos de peces post-carga. Lavado con manguera según sea necesario. Prioridad del Capitán."},
  {n:"Sala RSW",                          r:"Equipo Alpha",   f:"Cada 3 días", d:"Pisos y paredes con desengrasante. Revisar filtraciones. Limpiar drenajes y rejillas. Limpiar exterior de equipos de frío. Reportar anomalías a máquinas."},
  {n:"Pañol de Cubierta",                 r:"José Montecinos",f:"Semanal",     d:"Herramientas manuales, taladro, brocas, extensiones, discos de corte, aceitera, trapos, sellantes. Clasificar por tipo. Inventario semanal."},
  {n:"Pañol de Proa",                     r:"José Montecinos",f:"Semanal",     d:"Cabos (diámetro/longitud), estrobos, grilletes, tensores, eslingas, defensas, gancho de remolque, guías, roldanas. Método 5 días."},
  {n:"Pañol de Útiles de Aseo",           r:"Camilo Canales", f:"Cada 5 días", d:"Detergentes, desengrasantes, ácido oxálico, cloro, escobas, lampazos, baldes, esponjas, paños, guantes, bolsas basura, papel higiénico, jabón."},
  {n:"Oficina del Barco",                 r:"Ignacio Ulloa",  f:"Cada 2 días", d:"Orden de documentación, limpiar superficies y escritorio, papelero, limpieza de computador y equipos de comunicación. Mantener archivos ordenados."},
  {n:"Baño Cubierta Castillo",            r:"Equipo Beta",    f:"Cada 2 días", d:"WC interior/exterior/cisterna, lavamanos, espejo, suelo, paredes, griferías, sifones. Desinfección. Inox al brillo. Reposición insumos."},
  {n:"Vestidores",                        r:"Equipo Beta",    f:"Cada 2 días", d:"Barrer y lampazo. Limpiar lockers exteriores, bancos y superficies. Revisar orden de EPP personal. Ventilación."},
  {n:"Baño de Vestidores",                r:"Equipo Beta",    f:"Cada 2 días", d:"WC, lavamanos, ducha, espejo, suelo, paredes, griferías. Desinfección completa. Inox al brillo. Reposición de insumos."},
  {n:"Sala de Estar",                     r:"Rotativo",       f:"Cada 2 días", d:"Barrer, lampazo, limpiar superficies, sillones y muebles. Organizar. Limpiar televisor y equipos de entretenimiento."},
  {n:"Comedor",                           r:"Rotativo",       f:"Diaria — antes de 07:00", d:"Limpiar mesas y sillas, barrer y lampazo. Limpiar bajo mesas. Rejillas de ventilación. Inox al brillo. Dispensadores y refrigerador exterior."},
  {n:"Pañol de Víveres",                  r:"Cocinero",       f:"Semanal",     d:"Orden y limpieza de estanterías, suelo y paredes. Control de fechas de vencimiento. Inventario de productos. Coordinación con 1° Oficial."},
  {n:"Sala Banco de CO2",                 r:"Ignacio Ulloa",  f:"Mensual",     d:"Inspección visual de cilindros: asegurados, señalética visible, sin daños. Sin operar. Limpiar exterior. Registrar en planilla FIFI."},
  {n:"Pañol de Pinturas / SOPEP",         r:"José Montecinos",f:"Semanal",     d:"Pinturas (estado/cantidad), diluyentes, brochas, espátulas, lijas, masilla epoxi. SOPEP: absorbentes, barreras, pañoleta, guantes nitrilo, bolsas residuos."},
  {n:"Laboratorio",                       r:"Equipo Beta",    f:"Cada 3 días", d:"Limpiar superficies de trabajo, equipos y materiales de muestreo. Orden de reactivos y materiales. Revisar funcionamiento de equipos."},
  {n:"Sala de Oxigenación",               r:"Equipo Alpha",   f:"Cada 3 días", d:"Limpiar pisos y paredes. Revisar equipos de oxigenación: estado visual, conexiones, mangueras. Reportar anomalías a máquinas."},
  {n:"Sala Húmeda",                       r:"Equipo Alpha",   f:"Cada 3 días", d:"Limpieza de pisos y paredes. Retirar residuos orgánicos. Revisar drenajes. Limpiar exterior de equipos. Control de filtraciones."},
  {n:"Sala de Power Packs Proa y Pañol de Cadenas", r:"José Montecinos", f:"Semanal", d:"Limpiar suelo y paredes. Revisión visual de power packs: sin fugas, conexiones en buen estado. Inspeccionar cadenas del ancla. Reportar anomalías."},
];

// ─── COMPONENTE ZAFARRANCHOS ─────────────────────────────────────────────────
function SeccionZafarranchos({zafarranchos, setZafarranchos}){
  const [pedirClave,setPedirClave]=useState(null);
  const [modalDetalle,setModalDetalle]=useState(null);
  const [pedirClaveElim,setPedirClaveElim]=useState(null); // {zafId, idx}

  const intentarMarcar=(zaf)=>{
    setModalDetalle(null);
    setPedirClave(zaf);
  };

  const eliminarRegistro=(zafId, idx)=>{
    const prev=zafarranchos[zafId]||[];
    const next={...zafarranchos,[zafId]:prev.filter((_,i)=>i!==idx)};
    setZafarranchos(next);
  };

  const confirmarMarcar=(zaf)=>{
    const prev=zafarranchos[zaf.id]||[];
    const next={...zafarranchos,[zaf.id]:[...prev,{fecha:new Date().toLocaleString("es-CL"),realizado:true}]};
    setZafarranchos(next);
    setPedirClave(null);
  };

  const freqBadge=(freq)=>{
    const col=FREQ_COLOR[freq]||C.muted;
    return <span style={{display:"inline-block",fontSize:".62rem",letterSpacing:1,textTransform:"uppercase",padding:"2px 8px",borderRadius:2,background:col+"20",color:col,border:`1px solid ${col}40`,marginLeft:8}}>{freq}</span>;
  };

  return(
    <div>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.4rem",letterSpacing:2,marginBottom:6,borderBottom:`1px solid ${C.border}`,paddingBottom:8}}>Programa de Zafarranchos y Ejercicios</div>
      <div style={{fontSize:".75rem",color:C.dim,marginBottom:16,lineHeight:1.5}}>
        Ref. MGI 4.14 / ISM 8.2 / ISO 14001 4.4.7 — La frecuencia de los ejercicios según SOLAS III R-19. El entrenamiento dependerá de la necesidad de instrucción.
      </div>
      <div style={{fontSize:".72rem",color:C.amber,marginBottom:16,background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.2)",borderRadius:4,padding:"9px 13px"}}>
        🔒 Marcar un zafarrancho como realizado requiere la clave del 1° Oficial. Los registros no se pueden eliminar.
      </div>

      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
        {Object.entries(FREQ_COLOR).map(([freq,col])=>(
          <div key={freq} style={{display:"flex",alignItems:"center",gap:6,fontSize:".65rem",color:C.muted}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:col}}/>{freq}
          </div>
        ))}
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {ZAFARRANCHOS.map(zaf=>{
          const registros=zafarranchos[zaf.id]||[];
          const ultimo=registros[registros.length-1];
          return(
            <div key={zaf.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:5,overflow:"hidden"}}>
              <div style={{padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:4}}>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.1rem",color:C.white,letterSpacing:1}}>{zaf.num}. {zaf.nombre}</span>
                    {freqBadge(zaf.freq)}
                  </div>
                  <div style={{fontSize:".75rem",color:C.dim,marginTop:4,lineHeight:1.4}}>{zaf.ref}</div>
                  {registros.length>0&&(
                    <div style={{marginTop:8}}>
                      <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Realizaciones registradas ({registros.length}):</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                        {registros.map((r,i)=>(
                          <span key={i} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:".68rem",background:"rgba(16,185,129,.12)",border:"1px solid rgba(16,185,129,.3)",color:C.green,padding:"2px 8px",borderRadius:2}}>
                            ✓ {r.fecha}
                            <span onClick={(e)=>{e.stopPropagation();setPedirClaveElim({zafId:zaf.id,idx:i});}} style={{cursor:"pointer",color:C.red,fontSize:".7rem",fontWeight:700,padding:"0 2px"}}>✕</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button onClick={()=>intentarMarcar(zaf)}
                  style={{...estilos.btn(registros.length>0,C.green),padding:"6px 14px",fontSize:".7rem",flexShrink:0}}>
                  {registros.length>0?"+ Registrar nuevo":"Marcar como realizado"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {pedirClave&&(
        <ModalClave
          titulo={`Registrar zafarrancho: "${pedirClave.nombre}"`}
          onConfirm={()=>confirmarMarcar(pedirClave)}
          onCancel={()=>setPedirClave(null)}
        />
      )}
      {pedirClaveElim&&(
        <ModalClave
          titulo="¿Eliminar este registro de zafarrancho?"
          onConfirm={()=>{eliminarRegistro(pedirClaveElim.zafId,pedirClaveElim.idx);setPedirClaveElim(null);}}
          onCancel={()=>setPedirClaveElim(null)}
        />
      )}
    </div>
  );
}


// ─── MODAL TAREA EXTRA ────────────────────────────────────────────────────────
function ModalTareaExtra({dia, onGuardar, onCerrar}){
  const [desc,setDesc]=useState("");
  const [resp,setResp]=useState("");
  const puedeGuardar=desc.trim()&&resp;
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onClick={e=>e.target===e.currentTarget&&onCerrar()}>
      <div style={{background:"#0d1a2e",border:`1px solid ${C.amber}`,borderRadius:6,padding:24,width:"100%",maxWidth:520}}>
        <div style={{fontSize:".65rem",color:C.amber,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>+ Trabajo Adicional — Día {dia}</div>
        <div style={{fontSize:".78rem",color:C.dim,marginBottom:16,lineHeight:1.4}}>Agregar una tarea no considerada en el plan diario. Quedará registrada y visible para toda la tripulación.</div>

        <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Descripción del trabajo:</div>
        <textarea value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Describa el trabajo realizado..."
          style={{width:"100%",minHeight:100,background:"#080f1a",border:`1px solid ${C.border}`,borderRadius:4,color:C.text,fontFamily:"'IBM Plex Mono',monospace",fontSize:".82rem",padding:"10px 12px",resize:"vertical",outline:"none",lineHeight:1.5,marginBottom:14}}/>

        <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>¿Quién realizó este trabajo?</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:16}}>
          {TRIPULANTES.map(t=>(
            <button key={t.id} onClick={()=>setResp(`${t.nombre} — ${t.cargo}`)}
              style={{...estilos.btn(resp===`${t.nombre} — ${t.cargo}`,C.amber),padding:"8px 10px",fontSize:".72rem",textAlign:"left",textTransform:"none",letterSpacing:0}}>
              <div style={{fontWeight:600,color:resp===`${t.nombre} — ${t.cargo}`?C.amber:C.white}}>{t.nombre}</div>
              <div style={{fontSize:".6rem",color:C.muted,marginTop:1}}>{t.cargo}</div>
            </button>
          ))}
        </div>

        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button style={{...estilos.btn(false,C.muted),padding:"12px 20px",fontSize:".8rem",minHeight:44}} onClick={onCerrar}>Cancelar</button>
          <button style={{...estilos.btn(puedeGuardar,C.amber),padding:"12px 20px",fontSize:".8rem",minHeight:44}} onClick={()=>{if(puedeGuardar){onGuardar({desc,resp,fecha:new Date().toLocaleString("es-CL")});onCerrar();}}} disabled={!puedeGuardar}>Agregar</button>
        </div>
      </div>
    </div>
  );
}


// ─── BARRA GUARDIAS NAVEGACIÓN ────────────────────────────────────────────────
function BarraNavegacion({diaNum}){
  const nav = guardiaNavegacion(diaNum);
  return(
    <div style={{background:"rgba(139,92,246,.07)",border:"1px solid rgba(139,92,246,.25)",borderRadius:5,padding:"10px 14px",marginBottom:14}}>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:".95rem",letterSpacing:2,color:"#8b5cf6",marginBottom:8}}>🌙 Guardia de Navegación Nocturna</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
        {[nav.tramo1, nav.tramo2, nav.tramo3, nav.comedorManana].map((t,i)=>(
          <div key={i} style={{background:"rgba(139,92,246,.08)",borderRadius:4,padding:"7px 10px"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:".88rem",color:"#a78bfa",letterSpacing:1}}>{t.hora}</div>
            <div style={{fontSize:".72rem",color:C.white,marginTop:2}}>{t.equipo}</div>
            <div style={{fontSize:".65rem",color:C.dim,marginTop:1}}>{t.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── BANNER HORAS DISPONIBLES ─────────────────────────────────────────────────
function BannerHoras({operaciones}){
  const {horasDisponibles, tareasMax, horasOcupadas} = calcHorasDisponibles(operaciones);
  const ops = operaciones||[];
  if(ops.length === 0) return null;
  return(
    <div style={{background:"rgba(245,158,11,.07)",border:"1px solid rgba(245,158,11,.25)",borderRadius:5,padding:"10px 14px",marginBottom:14}}>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:".95rem",letterSpacing:2,color:C.amber,marginBottom:4}}>⏱ Horas Disponibles para Trabajos</div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
        <div style={{fontSize:".8rem",color:C.dim}}>Horas en operación: <strong style={{color:C.red}}>{horasOcupadas}h</strong></div>
        <div style={{fontSize:".8rem",color:C.dim}}>Horas disponibles: <strong style={{color:C.green}}>{horasDisponibles}h</strong></div>
        <div style={{fontSize:".8rem",color:C.dim}}>Tareas posibles aprox: <strong style={{color:C.amber}}>{tareasMax}</strong></div>
      </div>
      <div style={{fontSize:".7rem",color:C.dim,marginTop:6,fontStyle:"italic"}}>
        Las tareas del día se ajustan según las horas efectivas disponibles. Aseo comedor siempre obligatorio.
      </div>
    </div>
  );
}

// ─── MODAL COMPLETAR TAREA ────────────────────────────────────────────────────
function ModalCompletar({task, onCompletar, onCerrar}){
  const [autor,setAutor]=useState("");
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onClick={e=>e.target===e.currentTarget&&onCerrar()}>
      <div style={{background:"#0d1a2e",border:`1px solid ${C.green}`,borderRadius:6,padding:24,width:"100%",maxWidth:480}}>
        <div style={{fontSize:".65rem",color:C.green,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>✓ Marcar como realizado</div>
        <div style={{fontSize:".88rem",color:C.white,marginBottom:16,fontWeight:600,lineHeight:1.4}}>{task.t}</div>
        <div style={{fontSize:".65rem",color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>¿Quién realizó este trabajo?</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:16}}>
          {TRIPULANTES_OPERATIVOS.map(t=>(
            <button key={t.id} onClick={()=>setAutor(`${t.nombre} — ${t.cargo}`)}
              style={{...estilos.btn(autor===`${t.nombre} — ${t.cargo}`,C.green),padding:"8px 10px",fontSize:".72rem",textAlign:"left",textTransform:"none",letterSpacing:0}}>
              <div style={{fontWeight:600,color:autor===`${t.nombre} — ${t.cargo}`?C.green:C.white}}>{t.nombre}</div>
              <div style={{fontSize:".6rem",color:C.muted,marginTop:1}}>{t.cargo}</div>
            </button>
          ))}
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button style={estilos.btn(false,C.muted)} onClick={onCerrar}>Cancelar</button>
          <button style={estilos.btn(!!autor,C.green)} onClick={()=>{if(autor){onCompletar(task.id,autor);onCerrar();}}} disabled={!autor}>
            ✓ Confirmar realizado
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SECCIÓN CONTRAMAESTRE ────────────────────────────────────────────────────
function SeccionContramaestre({dia,completados,notas,diasCerrados,onMarcarCompletado,onDesmarcar,onCerrarDia,setPedirClaveCerrar}){

  // Snapshot of tasks taken when component mounts or dia changes
  // This prevents tasks from disappearing when marked complete during the session
  const [snapshot, setSnapshot] = useState(null);

  useEffect(()=>{
    // Build snapshot of pending tasks when component loads
    const snap = [];
    for(let d=1; d<dia; d++){
      if(diasCerrados[d]) continue;
      const plan = PLAN[d-1];
      if(!plan) continue;
      const todasTareas = [TAREA_COMEDOR,...plan.alpha,...plan.beta];
      const pendientes = todasTareas.filter(t=>!completados[`${d}_${t.id}`]);
      if(pendientes.length > 0){
        snap.push({diaNum:d, tareas:pendientes, total:todasTareas.length});
      }
    }
    setSnapshot(snap);
  },[dia]); // Only rebuild when day changes, not when completados changes

  // Use snapshot for rendering, but use live completados for tachado state
  const diasAMostrar = snapshot || [];

  if(diasAMostrar.length===0 && snapshot!==null){
    return(
      <div>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.4rem",letterSpacing:2,marginBottom:16,borderBottom:`1px solid ${C.border}`,paddingBottom:8}}>⚓ Contramaestre — Tareas Pendientes</div>
        <div style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.25)",borderRadius:5,padding:"20px",textAlign:"center"}}>
          <div style={{fontSize:"1.5rem",marginBottom:8}}>✓</div>
          <div style={{fontSize:".88rem",color:C.green,fontWeight:600}}>Todo al día</div>
          <div style={{fontSize:".75rem",color:C.dim,marginTop:4}}>No hay tareas pendientes de días anteriores.</div>
        </div>
      </div>
    );
  }

  if(snapshot===null){
    return(
      <div style={{padding:20,textAlign:"center",color:C.muted,fontSize:".8rem"}}>Cargando...</div>
    );
  }

  return(
    <div>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.4rem",letterSpacing:2,marginBottom:6,borderBottom:`1px solid ${C.border}`,paddingBottom:8}}>⚓ Contramaestre — Tareas Pendientes</div>
      <div style={{fontSize:".75rem",color:C.dim,marginBottom:16,lineHeight:1.5}}>
        Tareas pendientes de días anteriores. Las marcadas como realizadas quedan tachadas hasta que se cierre el día.
      </div>

      {diasAMostrar.map(({diaNum,tareas,total})=>{
        const completadasCount = tareas.filter(t=>!!completados[`${diaNum}_${t.id}`]).length;
        return(
          <div key={diaNum} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden",marginBottom:16}}>
            <div style={{padding:"11px 16px",background:"rgba(14,165,233,.08)",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.1rem",color:C.accent,letterSpacing:1}}>
                  DÍA {diaNum} — {fechaDia(diaNum)}
                </div>
                <div style={{fontSize:".68rem",color:C.muted,marginTop:2}}>
                  {completadasCount} de {tareas.length} completadas
                </div>
              </div>
              <button onClick={()=>setPedirClaveCerrar(diaNum)}
                style={{...estilos.btn(false,C.green),padding:"8px 16px",fontSize:".72rem"}}>
                🔒 Cerrar día {diaNum}
              </button>
            </div>
            <ul style={{listStyle:"none",padding:"0 16px",margin:0}}>
              {tareas.map(task=>{
                const comp=completados[`${diaNum}_${task.id}`];
                const isComp=!!comp;
                return(
                  <li key={task.id} style={{display:"flex",gap:10,alignItems:"flex-start",padding:"10px 0",borderBottom:`1px solid ${C.borderB}`,opacity:isComp?0.55:1}}>
                    <div style={{paddingTop:3,flexShrink:0}}>
                      {isComp
                        ? <div style={{width:18,height:18,borderRadius:"50%",background:C.green,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:C.bg,fontWeight:700}}>✓</div>
                        : <div style={{width:18,height:18,borderRadius:"50%",border:`1px solid ${C.muted}`,cursor:"pointer"}} onClick={()=>onMarcarCompletado(task,diaNum)}/>
                      }
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:".85rem",fontWeight:600,color:isComp?C.dim:C.white,lineHeight:1.4,textDecoration:isComp?"line-through":"none"}}>{task.t}</div>
                      {!isComp&&<div style={{fontSize:".75rem",color:C.dim,marginTop:2,lineHeight:1.4}}>{task.d}</div>}
                      {isComp&&<div style={{fontSize:".68rem",color:C.green,marginTop:2}}>✓ {comp.autor} — {comp.fecha}</div>}
                      {!isComp&&<div style={{marginTop:4}}><Tag cat={task.cat}/></div>}
                    </div>
                    {!isComp&&(
                      <button onClick={()=>onMarcarCompletado(task,diaNum)}
                        style={{...estilos.btn(false,C.green),padding:"4px 10px",fontSize:".65rem",flexShrink:0}}>
                        ✓ Realizado
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export default function App(){
  const [tab,setTab]=useState("daily");
  const [dia,setDia]=useState(()=>diaActual());
  const [cargaDays,setCargaDays]=useState({});
  const [notas,setNotas]=useState({});
  const [solas,setSolas]=useState({});
  const [cargaH,setCargaH]=useState({});
  const [solasWeek,setSolasWeek]=useState(1);
  const [modalNota,setModalNota]=useState(null);
  const [syncing,setSyncing]=useState(false);
  const [lastSync,setLastSync]=useState(null);
  const [syncError,setSyncError]=useState(false);
  const [dataCargada,setDataCargada]=useState(false); // prevents overwriting before load
  const [pedirClaveCD,setPedirClaveCD]=useState(false);
  const [pedirClaveNav,setPedirClaveNav]=useState(null);
  const [zafarranchos,setZafarranchos]=useState({});
  const [tareasExtra,setTareasExtra]=useState({});
  const [modalTareaExtra,setModalTareaExtra]=useState(false);
  const [completados,setCompletados]=useState({});
  const [modalCompletar,setModalCompletar]=useState(null);
  const [pedirClaveExtra,setPedirClaveExtra]=useState(null);
  const [diasCerrados,setDiasCerrados]=useState({});
  const [pedirClaveCerrar,setPedirClaveCerrar]=useState(null);
  const [modoReducido,setModoReducido]=useState({});
  const [pedirClaveModo,setPedirClaveModo]=useState(null);
  const [modalCompletarContra,setModalCompletarContra]=useState(null); // {task, diaNum}
  const toggleModoReducido=()=>{
    const next={...modoReducido,[dia]:!modoReducido[dia]};
    setModoReducido(next);
    guardar(cargaDays,notas,solas,cargaH,zafarranchos,tareasExtra,completados,diasCerrados,next);
  };
  const cerrarDia=(diaNum)=>{
    const next={...diasCerrados,[diaNum]:true};
    setDiasCerrados(next);
    guardar(cargaDays,notas,solas,cargaH,zafarranchos,tareasExtra,completados,next,modoReducido);
  }; // {delta}
  const timer=useRef(null);
  const syncingRef=useRef(false);
  const lastSaveTime=useRef(0);

  useEffect(()=>{
    (async()=>{
      try{
        const d=await dbRead();
        if(d.cargaDays) setCargaDays(d.cargaDays);
        if(d.notas)     setNotas(d.notas);
        if(d.solas)     setSolas(d.solas);
        if(d.cargaHorarios) setCargaH(d.cargaHorarios);
        if(d.zafarranchos) setZafarranchos(d.zafarranchos);
        if(d.tareasExtra) setTareasExtra(d.tareasExtra);
        if(d.completados) setCompletados(d.completados);
        if(d.diasCerrados) setDiasCerrados(d.diasCerrados);
        if(d.modoReducido) setModoReducido(d.modoReducido);
        setLastSync(new Date().toLocaleTimeString("es-CL"));
        setSyncError(false);
        setDataCargada(true);
      }catch(e){ setSyncError(true); setDataCargada(true); } // allow save even on error
    })();
  },[]);

  useEffect(()=>{
    const p=setInterval(async()=>{
      // Never poll if a save is in progress or was recent
      if(syncingRef.current) return;
      if(Date.now()-lastSaveTime.current < 15000) return;
      try{
        const d=await dbRead();
        // Only update state if server data is newer (merge, don't replace)
        // For completados and diasCerrados: merge server data WITH local data
        // Local changes always win over server for same key
        // All merges: local state always wins over server data
        if(d.cargaDays) setCargaDays(prev=>({...d.cargaDays,...prev}));
        if(d.notas)     setNotas(prev=>({...d.notas,...prev}));
        if(d.solas)     setSolas(prev=>({...d.solas,...prev}));
        if(d.cargaHorarios) setCargaH(prev=>({...d.cargaHorarios,...prev}));
        if(d.zafarranchos) setZafarranchos(prev=>({...d.zafarranchos,...prev}));
        if(d.tareasExtra) setTareasExtra(prev=>({...d.tareasExtra,...prev}));
        if(d.completados) setCompletados(prev=>({...d.completados,...prev}));
        if(d.diasCerrados) setDiasCerrados(prev=>({...d.diasCerrados,...prev}));
        if(d.modoReducido) setModoReducido(prev=>({...d.modoReducido,...prev}));
        setLastSync(new Date().toLocaleTimeString("es-CL"));
        setSyncError(false);
      }catch(e){ setSyncError(true); }
    },60000);
    return()=>clearInterval(p);
  },[]);

  const guardar=useCallback((cd,nt,sl,ch,zaf,te,comp,dc,mr)=>{
    if(!dataCargada) return; // NEVER save before initial data load
    if(timer.current) clearTimeout(timer.current);
    setSyncing(true);
    syncingRef.current=true; // block polling while save is pending
    timer.current=setTimeout(async()=>{
      try{ await dbWrite({cargaDays:cd,notas:nt,solas:sl,cargaHorarios:ch,zafarranchos:zaf,tareasExtra:te||{},completados:comp||{},diasCerrados:dc||{},modoReducido:mr||{}}); setLastSync(new Date().toLocaleTimeString("es-CL")); setSyncError(false); }
      catch(e){ setSyncError(true); }
      setSyncing(false);
      syncingRef.current=false;
      lastSaveTime.current=Date.now();
    },500);
  },[]);

  const toggleCarga=()=>{
    if(cargaDays[dia]){ setPedirClaveCD(true); return; }
    const next={...cargaDays,[dia]:true};
    setCargaDays(next);
    guardar(next,notas,solas,cargaH,zafarranchos,tareasExtra,completados,diasCerrados,modoReducido);
  };
  const confirmarQuitarCarga=()=>{
    const next={...cargaDays,[dia]:false};
    setCargaDays(next); guardar(next,notas,solas,cargaH,zafarranchos,tareasExtra,completados,diasCerrados,modoReducido); setPedirClaveCD(false);
  };
  const agregarOperacion=(op)=>{
    const prev=Array.isArray(cargaH[dia])?cargaH[dia]:[];
    const next={...cargaH,[dia]:[...prev,op]};
    setCargaH(next); guardar(cargaDays,notas,solas,next,zafarranchos,tareasExtra,completados,diasCerrados,modoReducido);
  };
  const cerrarOperacion=(op,horaFin,fechaFin)=>{
    // Update horaFin in previous day
    const prevDia=dia-1;
    const prevOps=Array.isArray(cargaH[prevDia])?[...cargaH[prevDia]]:[];
    const opIdx=prevOps.findIndex(o=>o.horaIni===op.horaIni&&o.tipo===op.tipo&&!o.horaFin);
    if(opIdx>=0){
      prevOps[opIdx]={...prevOps[opIdx],horaFin,fechaFin};
    }
    // Also add a continuation entry to current day so it stays marked as carga
    const currOps=Array.isArray(cargaH[dia])?[...cargaH[dia]]:[];
    // Only add if not already there
    const yaExiste=currOps.some(o=>o.horaIni===op.horaIni&&o.tipo===op.tipo&&o._continuacion);
    if(!yaExiste){
      currOps.push({...op,_continuacion:true,fechaIni:fechaFin||"",horaIni:"00:00",horaFin,fechaFin});
    }
    // Mark current day as carga
    const nextCarga={...cargaDays,[dia]:true};
    const nextCargaH={...cargaH,[prevDia]:prevOps,[dia]:currOps};
    setCargaDays(nextCarga);
    setCargaH(nextCargaH);
    guardar(nextCarga,notas,solas,nextCargaH,zafarranchos,tareasExtra,completados,diasCerrados,modoReducido);
  };
  const guardarNota=(taskId,texto,autor,diaOverride)=>{
    const key=`${diaOverride||dia}_${taskId}`;
    const prev=notas[key]||[];
    const next={...notas,[key]:[...prev,{texto,fecha:new Date().toLocaleString("es-CL"),autor:autor||"Tripulante"}]};
    setNotas(next); // notas saved below
    // Auto-tilde LSA/FIFI checklist if task is LSA/FIFI type
    let nextSolas=solas;
    if(LSA_TASK_MAP[taskId]){
      const semana=Math.ceil(PLAN.findIndex(d=>d.alpha.some(t=>t.id===taskId)||d.beta.some(t=>t.id===taskId)+1)/7)||1;
      const taskObj=[...PLAN.flatMap(d=>[...d.alpha,...d.beta])].find(t=>t.id===taskId);
      if(taskObj){
        const tipo=taskObj.cat==="LSA"?"lsa":"fifi";
        const idxs=LSA_TASK_MAP[taskId]||[];
        nextSolas={...solas};
        idxs.forEach(i=>{ nextSolas[`${tipo}_${semana}_${i}`]=true; });
        setSolas(nextSolas);
      }
    }
    guardar(cargaDays,notas,nextSolas,cargaH,zafarranchos,tareasExtra,completados,diasCerrados,modoReducido);
  };
  const eliminarNota=(taskId,idx,diaOverride)=>{
    const key=`${diaOverride||dia}_${taskId}`;
    const prev=notas[key]||[];
    const next={...notas,[key]:prev.filter((_,i)=>i!==idx)};
    setNotas(next); guardar(cargaDays,next,solas,cargaH,zafarranchos,tareasExtra,completados,diasCerrados,modoReducido);
  };
  const handleSolas=(next)=>{ setSolas(next); guardar(cargaDays,notas,next,cargaH,zafarranchos,tareasExtra,completados,diasCerrados,modoReducido); };
  const marcarCompletado=(taskId,autor,diaOverride)=>{
    const key=`${diaOverride||dia}_${taskId}`;
    setCompletados(prev=>{
      const next={...prev,[key]:{autor,fecha:new Date().toLocaleString("es-CL"),completado:true}};
      // Schedule save with latest state
      setTimeout(()=>guardar(cargaDays,notas,solas,cargaH,zafarranchos,tareasExtra,next,diasCerrados,modoReducido),0);
      return next;
    });
  };
  const desmarcarCompletado=(taskOrId)=>{
    const taskId=typeof taskOrId==="string"?taskOrId:taskOrId.id;
    const diaKey=typeof taskOrId==="object"&&taskOrId._diaKey?taskOrId._diaKey:dia;
    const key=`${diaKey}_${taskId}`;
    const next={...completados};
    delete next[key];
    setCompletados(next); guardar(cargaDays,notas,solas,cargaH,zafarranchos,tareasExtra,next,diasCerrados,modoReducido);
  };
  const [pedirClaveDesmarcar,setPedirClaveDesmarcar]=useState(null);
  const handleZafarranchos=(next)=>{ setZafarranchos(next); guardar(cargaDays,notas,solas,cargaH,next,tareasExtra,completados,diasCerrados,modoReducido); };
  const agregarTareaExtra=(tarea)=>{
    const key=`extra_${dia}`;
    const prev=tareasExtra[key]||[];
    const next={...tareasExtra,[key]:[...prev,{...tarea,id:`ex_${Date.now()}`}]};
    setTareasExtra(next); guardar(cargaDays,notas,solas,cargaH,zafarranchos,next,completados,diasCerrados,modoReducido);
  };
  const eliminarTareaExtra=(diaKey,idx)=>{
    const key=`extra_${diaKey}`;
    const prev=tareasExtra[key]||[];
    const next={...tareasExtra,[key]:prev.filter((_,i)=>i!==idx)};
    setTareasExtra(next); guardar(cargaDays,notas,solas,cargaH,zafarranchos,next,completados,diasCerrados,modoReducido);
  };

  const d=PLAN[dia-1];
  const isCarga=!!cargaDays[dia];
  const gs=guardiasDia(dia);
  const TABS=[{id:"daily",label:"Vista Diaria"},{id:"overview",label:"Resumen 25 Días"},{id:"solas",label:"SOLAS / FIFI"},{id:"panoles",label:"Pañoles & Zonas"},{id:"zafarranchos",label:"Zafarranchos"},{id:"contra",label:"⚓ Contramaestre"}];

  // Loading screen while fetching initial data
  if(!dataCargada){
    return(
      <div style={{...estilos.app,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"2rem",letterSpacing:4,color:C.accent}}>CUBIERTA WB</div>
        <div style={{fontSize:".8rem",color:C.muted,letterSpacing:2,textTransform:"uppercase"}}>Conectando con el servidor...</div>
        <div style={{width:40,height:40,border:`3px solid ${C.border}`,borderTop:`3px solid ${C.accent}`,borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
        <style>{`@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return(
    <div style={estilos.app}>
      <header style={{borderBottom:`1px solid ${C.border}`,padding:"16px 22px",display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:10,background:`linear-gradient(180deg,#0d1a2e 0%,#080f1a 100%)`}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"2.2rem",letterSpacing:4,lineHeight:1,color:C.white}}>CUBIERTA <span style={{color:C.accent}}>WB</span></div>
          <div style={{fontSize:".65rem",color:C.muted,letterSpacing:2,marginTop:3,textTransform:"uppercase"}}>Buque Wellboat · Embarco 17 May – 10 Jun 2026</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={()=>setPedirClaveNav({delta:-1})} style={{...estilos.btn(false,C.accent),fontSize:"1.1rem",padding:"5px 12px"}}>‹</button>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.5rem",color:C.accent,letterSpacing:2,minWidth:100,textAlign:"center"}}>DÍA {dia}</div>
            <button onClick={()=>setPedirClaveNav({delta:1})} style={{...estilos.btn(false,C.accent),fontSize:"1.1rem",padding:"5px 12px"}}>›</button>
          </div>
          <div style={{fontSize:".65rem",letterSpacing:1,textAlign:"right",
            color:syncError?C.red:syncing?C.amber:C.green,
            background:syncError?"rgba(239,68,68,.1)":syncing?"rgba(245,158,11,.1)":"rgba(16,185,129,.08)",
            border:`1px solid ${syncError?"rgba(239,68,68,.3)":syncing?"rgba(245,158,11,.3)":"rgba(16,185,129,.25)"}`,
            borderRadius:4,padding:"4px 10px"}}>
            {syncing?"⟳ Guardando…":syncError?"✗ Sin conexión — reintentando…":lastSync?`✓ Listo — ${lastSync}`:"Conectando…"}
          </div>
        </div>
      </header>

      <div style={{display:"flex",gap:2,padding:"10px 22px 0",borderBottom:`1px solid ${C.border}`,flexWrap:"wrap",background:C.surface}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:".72rem",textTransform:"uppercase",letterSpacing:1.5,padding:"9px 16px",background:tab===t.id?C.surface:"transparent",color:tab===t.id?C.accent:C.muted,border:`1px solid ${tab===t.id?C.border:"transparent"}`,borderBottom:`1px solid ${tab===t.id?C.surface:"transparent"}`,borderRadius:"4px 4px 0 0",cursor:"pointer",marginBottom:-1}}>
            {t.label}
          </button>
        ))}
        {tab==="solas"&&(
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6,paddingBottom:6}}>
            <span style={{fontSize:".65rem",color:C.muted}}>Semana:</span>
            {[1,2,3,4].map(w=><button key={w} onClick={()=>setSolasWeek(w)} style={estilos.btn(solasWeek===w,C.amber)}>{w}</button>)}
          </div>
        )}
      </div>

      <main style={{padding:"18px 22px",maxWidth:1400,margin:"0 auto"}}>

        {tab==="daily"&&(
          <div>
            <BarraGuardias diaNum={dia}/>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:12}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"2.8rem",lineHeight:1}}>
                  DÍA <span style={{color:C.accent}}>{dia}</span>
                  <span style={{fontSize:"1.1rem",color:C.muted,marginLeft:12,letterSpacing:2,textTransform:"capitalize"}}>{fechaDia(dia)}</span>
                </div>
                <div style={{fontSize:".75rem",color:C.dim,marginTop:6,fontStyle:"italic",lineHeight:1.5}}>{d.note}</div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
                {modoReducido[dia]&&<span style={{background:"rgba(245,158,11,.15)",border:"1px solid #f59e0b",color:"#f59e0b",fontSize:".67rem",letterSpacing:1.5,textTransform:"uppercase",padding:"4px 10px",borderRadius:2}}>⚡ OPERACIONES CARGA/DESCARGA</span>}
                <button onClick={()=>setPedirClaveModo(true)} style={estilos.btn(!!modoReducido[dia],C.amber)}>
                  {modoReducido[dia]?"✓ Operaciones activas — quitar":"⚡ Operaciones Carga/Descarga"}
                </button>
              </div>
            </div>

            

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(min(100%,480px),1fr))",gap:16,marginBottom:16}}>
              <CardEquipo titulo="⚓ EQUIPO ALPHA" miembros={`${gs.a.eq} / ${gs.b.eq}`} guardia={`Guardias ${gs.a.t} y ${gs.b.t}`} color={C.accent} tareas={(()=>{
  const base=[TAREA_COMEDOR,...d.alpha];
  if(!modoReducido[dia]) return base;
  const esencial=(t)=>{
    if(t.id===TAREA_COMEDOR.id) return true;
    if(completados[`${dia}_${t.id}`]) return true; // always show completed tasks
    if(["MANT","LSA","FIFI","INS","OX"].includes(t.cat)) return true;
    if(t.cat==="HK"&&(t.t.toLowerCase().includes("cubierta")||t.t.toLowerCase().includes("trinca")||t.t.toLowerCase().includes("aseo cubierta")||t.t.toLowerCase().includes("lavado cubierta"))) return true;
    return false;
  };
  return [...base.filter(esencial),...TAREAS_CARGA.alpha];
})()} notas={notas} completados={completados} diaKey={dia} onAbrir={(t)=>setModalNota({...t,_diaKey:dia})} onCompletar={setModalCompletar} onDesmarcar={setPedirClaveDesmarcar}/>
              <CardEquipo titulo="🐟 EQUIPO BETA" miembros={gs.c.eq} guardia={`Guardia ${gs.c.t}`} color={C.amber} tareas={(()=>{
  const base=d.beta;
  if(!modoReducido[dia]) return base;
  const esencial=(t)=>{
    if(completados[`${dia}_${t.id}`]) return true; // always show completed tasks
    if(["MANT","LSA","FIFI","INS","OX"].includes(t.cat)) return true;
    if(t.cat==="HK"&&(t.t.toLowerCase().includes("cubierta")||t.t.toLowerCase().includes("trinca")||t.t.toLowerCase().includes("aseo cubierta")||t.t.toLowerCase().includes("lavado cubierta"))) return true;
    return false;
  };
  return [...base.filter(esencial),...TAREAS_CARGA.beta];
})()} notas={notas} completados={completados} diaKey={dia} onAbrir={(t)=>setModalNota({...t,_diaKey:dia})} onCompletar={setModalCompletar} onDesmarcar={setPedirClaveDesmarcar}/>
            </div>

            <div style={{background:"rgba(14,165,233,.05)",borderLeft:`3px solid ${C.accent}`,borderRadius:"0 4px 4px 0",padding:"10px 14px",fontSize:".8rem",color:C.dim,fontStyle:"italic",lineHeight:1.5,marginBottom:16}}>
              <strong style={{color:C.accent}}>José Montecinos</strong> — Contramaestre. Supervisión e informe permanente, independiente del turno. Presente en todas las maniobras de amarre, desamarre, fondeos, muelles y extras. &nbsp;|&nbsp;
              <strong style={{color:C.amber}}>Ignacio Ulloa</strong> — 2° Piloto. A cargo de todas las inspecciones y rutinas SOLAS/FIFI.
            </div>

            {/* TRABAJOS ADICIONALES */}
            {(tareasExtra[`extra_${dia}`]||[]).length>0&&(
              <div style={{background:"rgba(245,158,11,.06)",border:`1px solid rgba(245,158,11,.25)`,borderRadius:5,padding:"14px 16px",marginBottom:12}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.1rem",letterSpacing:2,color:C.amber,marginBottom:10}}>Trabajos Adicionales del Día</div>
                {(tareasExtra[`extra_${dia}`]||[]).map((t,i)=>(
                  <div key={i} style={{borderBottom:`1px solid rgba(245,158,11,.15)`,paddingBottom:8,marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:".85rem",color:C.white,fontWeight:600}}>{t.desc}</div>
                      <div style={{fontSize:".72rem",color:C.amber,marginTop:3}}>Realizado por: {t.resp}</div>
                      <div style={{fontSize:".65rem",color:C.muted,marginTop:1}}>{t.fecha}</div>
                    </div>
                    <button onClick={()=>setPedirClaveExtra({diaKey:dia,idx:i})}
                      style={{...estilos.btn(false,C.red),padding:"3px 9px",fontSize:".6rem",flexShrink:0}}>🗑</button>
                  </div>
                ))}
              </div>
            )}
            <button onClick={()=>setModalTareaExtra(true)}
              style={{...estilos.btn(false,C.amber),width:"100%",padding:"10px",fontSize:".78rem",textAlign:"center",marginBottom:8}}>
              + Agregar trabajo adicional al día {dia}
            </button>
          </div>
        )}

        {tab==="overview"&&(
          <div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.4rem",letterSpacing:2,marginBottom:16,borderBottom:`1px solid ${C.border}`,paddingBottom:8}}>Resumen del Embarco — 25 Días</div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
              {[{c:C.accent,l:"Día actual"},{c:C.red,l:"Carga/Descarga"},{c:C.border,l:"Normal"}].map(x=>(
                <div key={x.l} style={{display:"flex",alignItems:"center",gap:6,fontSize:".67rem",color:C.muted,textTransform:"uppercase",letterSpacing:1}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:x.c}}/>{x.l}
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
              {PLAN.map((_,i)=>{
                const d2=i+1;
                const esCarga=!!cargaDays[d2];
                const esActual=d2===dia;
                const fecha=new Date(INICIO);
                fecha.setDate(fecha.getDate()+i);
                const dd=fecha.toLocaleDateString("es-CL",{day:"numeric",month:"short"});
                const sem=Math.ceil(d2/7);
                return(
                  <div key={d2} onClick={()=>setPedirClaveNav({delta:d2-dia,targetDay:d2})} style={{background:esActual?"rgba(14,165,233,.1)":C.surface,cursor:"pointer",border:`1px solid ${esActual?C.accent:esCarga?"rgba(239,68,68,.4)":C.border}`,borderRadius:4,padding:"8px 8px",transition:"all .15s"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.15rem",color:C.white}}>{d2}</div>
                      <div style={{width:6,height:6,borderRadius:"50%",background:esActual?C.accent:esCarga?C.red:C.border}}/>
                    </div>
                    <div style={{fontSize:".58rem",color:C.muted,letterSpacing:1,textTransform:"capitalize",marginTop:1}}>{dd}</div>
                    {getOpsForDay(d2,cargaH).map((op,oi)=>(
                      <div key={oi} style={{fontSize:".6rem",color:op._crossDay?C.amber:C.red,marginTop:3,background:"rgba(239,68,68,.1)",borderRadius:2,padding:"1px 4px"}}>⚡ {op.tipo} {op.horaIni||op.inicio}{op._crossDay?" (cont.)":""}</div>
                    ))}
                    {(tareasExtra[`extra_${d2}`]||[]).length>0&&(
                      <div style={{fontSize:".6rem",color:C.amber,marginTop:3}}>+ {(tareasExtra[`extra_${d2}`]||[]).length} extra{(tareasExtra[`extra_${d2}`]||[]).length>1?"s":""}</div>
                    )}
                    {(()=>{
                      const allTasks=[...(PLAN[d2-1]?.alpha||[]),...(PLAN[d2-1]?.beta||[])];
                      const notasDelDia=allTasks.filter(t=>(notas[t.id]||[]).length>0);
                      return notasDelDia.length>0?(
                        <div style={{fontSize:".58rem",color:C.green,marginTop:2}}>📝 {notasDelDia.length} nota{notasDelDia.length>1?"s":""}</div>
                      ):null;
                    })()}
                    {!esCarga&&<div style={{fontSize:".55rem",color:C.muted,marginTop:2}}>Sem {sem}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab==="solas"&&<SeccionSolas solas={solas} setSolas={handleSolas} semana={solasWeek}/>}

        {tab==="contra"&&(
          <SeccionContramaestre
            dia={dia}
            completados={completados}
            notas={notas}
            diasCerrados={diasCerrados}
            onMarcarCompletado={(task,diaNum)=>setModalCompletarContra({task,diaNum})}
            onDesmarcar={setPedirClaveDesmarcar}
            onCerrarDia={cerrarDia}
            setPedirClaveCerrar={setPedirClaveCerrar}
          />
        )}

        {tab==="zafarranchos"&&(
          <SeccionZafarranchos zafarranchos={zafarranchos} setZafarranchos={handleZafarranchos}/>
        )}

        {tab==="panoles"&&(
          <div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"1.4rem",letterSpacing:2,marginBottom:16,borderBottom:`1px solid ${C.border}`,paddingBottom:8}}>Pañoles, Salas y Responsables</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(270px,1fr))",gap:12,marginBottom:24}}>
              {PANOLES_LISTA.map(p=>(
                <div key={p.n} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:5,padding:"13px 15px"}}>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:".95rem",letterSpacing:1.5,color:C.amber,marginBottom:5}}>{p.n}</div>
                  <div style={{fontSize:".78rem",color:C.dim,lineHeight:1.6}}>{p.d}</div>
                  <div style={{marginTop:7,fontSize:".67rem",color:C.accent,textTransform:"uppercase",letterSpacing:1}}>Resp: {p.r} · {p.f}</div>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>

      {modalNota&&<ModalNota task={modalNota} notas={notas} diaKey={modalNota._diaKey||dia} onGuardar={guardarNota} onEliminar={eliminarNota} onCerrar={()=>setModalNota(null)}/>}
      {pedirClaveCD&&<ModalClave titulo="¿Desmarcar este día como carga/descarga?" onConfirm={confirmarQuitarCarga} onCancel={()=>setPedirClaveCD(false)}/>}
      {pedirClaveNav&&<ModalClave titulo={`Navegar al día ${dia+(pedirClaveNav?.delta||0)} — solo el 1° Oficial puede cambiar el día`} onConfirm={()=>{if(pedirClaveNav.targetDay!==undefined){setDia(pedirClaveNav.targetDay);setTab("daily");}else{setDia(d=>Math.max(1,Math.min(25,d+pedirClaveNav.delta)));}setPedirClaveNav(null);}} onCancel={()=>setPedirClaveNav(null)}/>}
      {modalTareaExtra&&<ModalTareaExtra dia={dia} onGuardar={agregarTareaExtra} onCerrar={()=>setModalTareaExtra(false)}/>}
      {modalCompletar&&<ModalCompletar task={modalCompletar} onCompletar={marcarCompletado} onCerrar={()=>setModalCompletar(null)}/>}
      {modalCompletarContra&&<ModalCompletar task={modalCompletarContra.task} onCompletar={(taskId,autor)=>{marcarCompletado(taskId,autor,modalCompletarContra.diaNum);setModalCompletarContra(null);}} onCerrar={()=>setModalCompletarContra(null)}/>}
      {pedirClaveExtra&&<ModalClave titulo="¿Eliminar este trabajo adicional?" onConfirm={()=>{eliminarTareaExtra(pedirClaveExtra.diaKey,pedirClaveExtra.idx);setPedirClaveExtra(null);}} onCancel={()=>setPedirClaveExtra(null)}/>}
      {pedirClaveDesmarcar&&<ModalClave titulo={`¿Desmarcar tarea como no realizada? "${pedirClaveDesmarcar.t}"`} onConfirm={()=>{desmarcarCompletado(pedirClaveDesmarcar);setPedirClaveDesmarcar(null);}} onCancel={()=>setPedirClaveDesmarcar(null)}/>}
      {pedirClaveModo&&<ModalClave
        titulo={modoReducido[dia]?`¿Desactivar operaciones carga/descarga para el día ${dia}? Volverán a aparecer todas las tareas.`:`¿Activar operaciones carga/descarga para el día ${dia}? Se mostrarán solo las tareas esenciales más las de operación.`}
        onConfirm={()=>{toggleModoReducido();setPedirClaveModo(null);}}
        onCancel={()=>setPedirClaveModo(null)}
      />}
      {pedirClaveCerrar&&<ModalClave titulo={`¿Cerrar el Día ${pedirClaveCerrar} como completado? Las tareas pendientes no aparecerán más en la pestaña Contramaestre.`} onConfirm={()=>{cerrarDia(pedirClaveCerrar);setPedirClaveCerrar(null);}} onCancel={()=>setPedirClaveCerrar(null)}/>}
    </div>
  );
}
