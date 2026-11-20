# Local setup

V1 checkout validation code is already in this repository.

## Shopify app shell

The Shopify app shell itself must be linked to the Partner app because Shopify credentials are account-specific and should not be committed.

If the app record has not yet been created, from this repository run:

    shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router

Choose **Shipping Address Rules**.

If the app already exists in Shopify Dev Dashboard, use:

    shopify app config link

Keep the existing `extensions/cart-checkout-validation` directory from this repository.

## Install

    npm install

## Generate Shopify Function types

    shopify app function typegen --path extensions/cart-checkout-validation

## Unit tests

    npx vitest run extensions/cart-checkout-validation/src/cart_validations_generate_run.test.js

## Development

    shopify app dev

The Function target is `cart.validations.generate.run`.

V1 deliberately has no network call during checkout and uses high-precision address matching.
