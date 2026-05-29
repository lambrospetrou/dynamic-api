export class BoundedCache<V> {
	readonly #max: number;
	readonly #map = new Map<string, V>();

	constructor(max: number) {
		this.#max = max;
	}

	get(key: string): V | undefined {
		return this.#map.get(key);
	}

	set(key: string, value: V): void {
		if (this.#map.size >= this.#max) {
			this.#map.delete(this.#map.keys().next().value!);
		}
		this.#map.set(key, value);
	}

	delete(key: string): void {
		this.#map.delete(key);
	}
}
