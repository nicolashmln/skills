---
title: Getting started
description: Install the package and run your first command.
draft: false
layout: docs
---

# Getting started

Install the package with your favorite package manager, then import it into your project.

```ts
import { createClient } from 'awesome-sdk'

const client = createClient({ apiKey: process.env.API_KEY })
await client.connect()
```

Use the `createClient` helper to open a connection. See the [API reference](/docs/api) for every available option.

::callout{icon="i-heroicons-light-bulb" color="amber"}
Keep your API key secret. Never commit it to source control.
::
