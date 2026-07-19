# Guía de contribución

¡Gracias por tu interés en mejorar **Panadería Luz Marina**! Esta guía resume el
flujo de trabajo y las convenciones del proyecto.

## Requisitos previos

- Node.js **20.x** y npm 10+
- Lee el [README](README.md) para entender la arquitectura (frontend estático +
  backend Express/SQLite/WebSocket).

## Puesta en marcha

```bash
git clone https://github.com/JorgeAHernandezC80/PanaderiaLuzMarina.git
cd PanaderiaLuzMarina
npm install
cp .env.example .env   # ajusta las variables del backend
```

## Flujo de trabajo

1. Crea una rama a partir de `main`:
   ```bash
   git checkout -b feat/mi-cambio
   ```
2. Haz tus cambios en commits pequeños y descriptivos.
3. Antes de subir, asegúrate de que todo pasa en local:
   ```bash
   npm run lint
   npm run format:check
   npm test
   ```
   Puedes autocorregir estilo con `npm run lint:fix` y `npm run format`.
4. Abre un Pull Request contra `main`. El CI ejecutará lint, formato y pruebas.

## Estilo de código

- El estilo lo imponen **ESLint** y **Prettier**; no discutas espacios ni comillas,
  deja que las herramientas decidan.
- Mantén las funciones pequeñas y con nombres claros.
- El backend es CommonJS (`require`); el frontend usa ES Modules (`import`).

## Convención de commits

Usa mensajes en presente y con prefijo de tipo cuando aplique:

```
feat: agrega filtro por categoría en el catálogo
fix: corrige el cálculo del total en el carrito
docs: actualiza la sección de despliegue
test: cubre validación de teléfono
chore: actualiza dependencias
```

## Pruebas

- Toda lógica nueva debe venir acompañada de pruebas en `tests/`.
- No bajes la cobertura existente sin una buena razón.

## Seguridad

- **Nunca** subas secretos, tokens ni el archivo `.env`.
- La base de datos (`*.db`) contiene datos de clientes (PII) y no se versiona.
- Si encuentras una vulnerabilidad, repórtala de forma privada en los
  [issues](https://github.com/JorgeAHernandezC80/PanaderiaLuzMarina/issues) marcándola
  como sensible en lugar de exponer los detalles públicamente.
