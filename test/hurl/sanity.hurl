# Sanity test suite against a running instance.
# Usage: hurl --variable base_url=http://localhost:8787 test/hurl/sanity.hurl
#

# ---------------------------------------------------------------------------
# 1. Create a random-number app
# ---------------------------------------------------------------------------
POST {{base_url}}/api/apps
Content-Type: application/json
{
  "slug": "random-number",
  "description": "An API with a single route GET / that returns a JSON object with one field 'number' set to a random integer between 1 and 100, e.g. {\"number\": 42}"
}

HTTP 201
[Captures]
app_id: jsonpath "$.id"

[Asserts]
jsonpath "$.id" isString
jsonpath "$.slug" == "random-number"
jsonpath "$.current.version" == 1
jsonpath "$.current.code" isString
jsonpath "$.current.code" contains "DynamicHandler"

# ---------------------------------------------------------------------------
# 2. Call the app and assert it returns a number in [1, 100]
# ---------------------------------------------------------------------------
GET {{base_url}}/apps/{{app_id}}/

HTTP 200
Content-Type: application/json
[Asserts]
jsonpath "$.number" isInteger
jsonpath "$.number" >= 1
jsonpath "$.number" <= 100

# ---------------------------------------------------------------------------
# 3. List apps and confirm the new app appears
# ---------------------------------------------------------------------------
GET {{base_url}}/api/apps

HTTP 200
[Asserts]
jsonpath "$.apps" isCollection
jsonpath "$.apps[*].id" contains {{app_id}}
jsonpath "$.apps[*].slug" contains "random-number"
